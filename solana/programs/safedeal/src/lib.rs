//! SafeDeal — escrow dla transakcji między obcymi ludźmi, na Solanie.
//!
//! Kupujący wpłaca tokeny do sejfu (konto tokenowe, którego właścicielem jest PDA transakcji — nie
//! człowiek), sprzedawca wysyła paczkę, niezależne oracle potwierdzają doręczenie, a po oknie
//! reklamacyjnym pieniądze trafiają do sprzedawcy. Każdy stan nieterminalny ma deadline, po którym
//! `settle_expired` (może je wywołać KAŻDY) rozstrzyga sprawę deterministycznie — żadna strona nie
//! może zamrozić pieniędzy, znikając.
//!
//! Brak instrukcji administracyjnych: parametry (token, oracle, arbitrzy, terminy, kaucja) zapisuje
//! `initialize` raz i na zawsze. Nikt — także autor — nie może ich później zmienić ani wypłacić
//! cudzych środków z sejfu.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("B7aMTf719JpBybXggkHyFsAKemfM6eNbAU6mA7rUzJmn");

pub const MAX_ORACLES: usize = 5;
pub const MAX_ARBITERS: usize = 5;
/// Ile tokenów (w najmniejszych jednostkach) wydaje kran testowego USDC — 1000 przy 6 miejscach.
pub const FAUCET_AMOUNT: u64 = 1_000_000_000;

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    None = 0,
    Created = 1,       // oferta czeka na kupującego
    Funded = 2,        // środki w sejfie, czekamy na nadanie        → timeout: zwrot kupującemu
    Shipped = 3,       // paczka w drodze                            → timeout: wypłata sprzedawcy
    Delivered = 4,     // oracle: doręczono, trwa okno reklamacji    → timeout: wypłata sprzedawcy
    Disputed = 5,      // kupujący otworzył spór (z kaucją)          → timeout: kupujący wygrywa
    InArbitration = 6, // obie kaucje wpłacone, głosują arbitrzy     → timeout: podział 50/50
    Released = 7,      // ✔ sprzedawca dostał pieniądze
    Refunded = 8,      // ✔ kupujący dostał zwrot
    Split = 9,         // ✔ arbitraż nie zapadł — podział po połowie
    Cancelled = 10,    // ✔ oferta anulowana przed wpłatą
    Settled = 11,      // ✔ ugoda — strony same uzgodniły podział
}

impl State {
    fn from_u8(v: u8) -> State {
        match v {
            1 => State::Created,
            2 => State::Funded,
            3 => State::Shipped,
            4 => State::Delivered,
            5 => State::Disputed,
            6 => State::InArbitration,
            7 => State::Released,
            8 => State::Refunded,
            9 => State::Split,
            10 => State::Cancelled,
            11 => State::Settled,
            _ => State::None,
        }
    }
}

#[program]
pub mod safedeal {
    use super::*;

    // ───────────────────────────── konfiguracja (raz) ─────────────────────────────

    /// Jednorazowo zapisuje reguły gry. Nie ma instrukcji, która mogłaby je zmienić.
    pub fn initialize(ctx: Context<Initialize>, p: InitParams) -> Result<()> {
        require!(
            p.oracles.len() <= MAX_ORACLES
                && p.oracle_quorum >= 1
                && p.oracle_quorum as usize <= p.oracles.len()
                && p.arbiters.len() <= MAX_ARBITERS
                && p.arbiter_quorum >= 1
                && p.arbiter_quorum as usize <= p.arbiters.len()
                && p.bond_bps <= 10_000,
            SafeDealError::InvalidParams
        );
        let c = &mut ctx.accounts.config;
        c.mint = ctx.accounts.mint.key();
        c.oracles = p.oracles;
        c.oracle_quorum = p.oracle_quorum;
        c.arbiters = p.arbiters;
        c.arbiter_quorum = p.arbiter_quorum;
        c.ship_window = p.ship_window;
        c.transit_window = p.transit_window;
        c.inspection_window = p.inspection_window;
        c.response_window = p.response_window;
        c.arbitration_window = p.arbitration_window;
        c.reveal_window = p.reveal_window;
        c.bond_bps = p.bond_bps;
        c.deal_count = 0;
        c.arb_with_majority = [0; MAX_ARBITERS];
        c.arb_against_majority = [0; MAX_ARBITERS];
        c.arb_missed = [0; MAX_ARBITERS];
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Kran testowego USDC (tylko devnet) — mint należy do PDA programu, więc nikt nie dodrukuje
    /// tokenów poza tą instrukcją.
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"mint_auth", &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            FAUCET_AMOUNT,
        )
    }

    // ───────────────────────────── sprzedawca ─────────────────────────────

    /// Oferta z opisem i hashem zdjęcia. Po wpłacie nic z tego nie da się zmienić — to, co kupujący
    /// widział przy zakupie, jest zamrożone on-chain i służy jako dowód w sporze.
    /// `buyer = None` → oferta otwarta dla każdego z linkiem.
    pub fn create_deal(ctx: Context<CreateDeal>, a: CreateDealArgs) -> Result<()> {
        require!(a.amount > 0, SafeDealError::InvalidParams);
        require!(
            a.title.len() <= 80 && a.description.len() <= 500 && a.photo_uri.len() <= 200,
            SafeDealError::InvalidParams
        );
        let seller = ctx.accounts.seller.key();
        if let Some(b) = a.buyer {
            require!(b != seller, SafeDealError::InvalidParams);
        }
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.deal_count += 1;

        let d = &mut ctx.accounts.deal;
        d.id = config.deal_count;
        d.seller = seller;
        d.buyer = a.buyer.unwrap_or_default();
        d.amount = a.amount;
        d.bond = 0;
        d.state = State::Created as u8;
        d.deadline = 0;
        d.created_at = now;
        d.title = a.title;
        d.description = a.description;
        d.photo_uri = a.photo_uri;
        d.photo_hash = a.photo_hash;
        d.pickup_allowed = a.pickup_allowed;
        d.bump = ctx.bumps.deal;
        d.vault_bump = ctx.bumps.vault;

        init_profile(&mut ctx.accounts.seller_profile, seller, ctx.bumps.seller_profile);

        emit!(DealCreated { id: d.id, seller, buyer: d.buyer, amount: d.amount, title: d.title.clone() });
        Ok(())
    }

    pub fn cancel(ctx: Context<SellerAction>) -> Result<()> {
        let d = &mut ctx.accounts.deal;
        expect(d, State::Created)?;
        require_keys_eq!(ctx.accounts.seller.key(), d.seller, SafeDealError::NotAllowed);
        close(d, State::Cancelled);
        Ok(())
    }

    pub fn mark_shipped(ctx: Context<SellerAction>, tracking: String) -> Result<()> {
        require!(!tracking.is_empty() && tracking.len() <= 120, SafeDealError::InvalidParams);
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        expect(d, State::Funded)?;
        require_keys_eq!(ctx.accounts.seller.key(), d.seller, SafeDealError::NotAllowed);
        require!(d.pickup_hash == [0u8; 32], SafeDealError::NotAllowed);
        require!(now <= d.deadline, SafeDealError::DeadlinePassed);
        d.tracking = tracking.clone();
        d.state = State::Shipped as u8;
        d.deadline = now + c.transit_window + c.inspection_window;
        emit!(DealShipped { id: d.id, tracking, deadline: d.deadline });
        Ok(())
    }

    /// Sprzedawca idzie do arbitrażu: wpłaca taką samą kaucję jak kupujący.
    pub fn respond_to_dispute(ctx: Context<PartyDeposit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        expect(d, State::Disputed)?;
        require_keys_eq!(ctx.accounts.actor.key(), d.seller, SafeDealError::NotAllowed);
        require!(now <= d.deadline, SafeDealError::DeadlinePassed);
        d.state = State::InArbitration as u8;
        // deadline = koniec fazy ujawniania; koniec fazy commit = deadline - reveal_window
        d.deadline = now + c.arbitration_window + c.reveal_window;
        let bond = d.bond;
        let id = d.id;
        let deadline = d.deadline;
        deposit(&ctx.accounts.actor_ata, &ctx.accounts.vault, &ctx.accounts.actor, &ctx.accounts.token_program, bond)?;
        emit!(ArbitrationStarted { id, deadline });
        Ok(())
    }

    // ───────────────────────────── kupujący ─────────────────────────────

    /// Wpłata do sejfu. `pickup_hash` (opcjonalnie) = sha256(id_le ‖ sha256(kod)) — odbiór osobisty:
    /// kupujący pokaże kod dopiero po obejrzeniu przedmiotu.
    pub fn fund(ctx: Context<Fund>, pickup_hash: Option<[u8; 32]>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let buyer = ctx.accounts.buyer.key();
        let d = &mut ctx.accounts.deal;
        expect(d, State::Created)?;
        require_keys_neq!(buyer, d.seller, SafeDealError::NotAllowed);
        require!(d.buyer == Pubkey::default() || d.buyer == buyer, SafeDealError::NotAllowed);
        if let Some(h) = pickup_hash {
            require!(d.pickup_allowed && h != [0u8; 32], SafeDealError::NotAllowed);
            d.pickup_hash = h;
        }
        d.buyer = buyer;
        d.state = State::Funded as u8;
        d.deadline = now + c.ship_window;
        let (id, amount, deadline) = (d.id, d.amount, d.deadline);

        init_profile(&mut ctx.accounts.buyer_profile, buyer, ctx.bumps.buyer_profile);
        deposit(&ctx.accounts.buyer_ata, &ctx.accounts.vault, &ctx.accounts.buyer, &ctx.accounts.token_program, amount)?;
        emit!(DealFunded { id, buyer, deadline });
        Ok(())
    }

    pub fn open_dispute(ctx: Context<PartyDeposit>, reason: String) -> Result<()> {
        require!(!reason.is_empty() && reason.len() <= 280, SafeDealError::InvalidParams);
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        require_keys_eq!(ctx.accounts.actor.key(), d.buyer, SafeDealError::NotAllowed);
        let s = State::from_u8(d.state);
        require!(s == State::Shipped || s == State::Delivered, SafeDealError::WrongState);
        require!(now <= d.deadline, SafeDealError::DeadlinePassed);
        let bond = ((d.amount as u128 * c.bond_bps as u128) / 10_000) as u64;
        d.bond = bond;
        d.state = State::Disputed as u8;
        d.deadline = now + c.response_window;
        d.dispute_reason = reason.clone();
        let (id, deadline) = (d.id, d.deadline);
        deposit(&ctx.accounts.actor_ata, &ctx.accounts.vault, &ctx.accounts.actor, &ctx.accounts.token_program, bond)?;
        emit!(DisputeOpened { id, reason, deadline });
        Ok(())
    }

    // ───────────────────────────── oracle ─────────────────────────────

    /// Oracle potwierdza "doręczono". Stan zmienia się dopiero po `oracle_quorum` zgodnych
    /// potwierdzeniach różnych źródeł — jedno przekupione lub zepsute źródło nie wystarczy.
    pub fn confirm_delivery(ctx: Context<OracleAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let idx = c
            .oracles
            .iter()
            .position(|o| *o == ctx.accounts.oracle.key())
            .ok_or(SafeDealError::NotAllowed)?;
        let d = &mut ctx.accounts.deal;
        expect(d, State::Shipped)?;
        let bit = 1u8 << idx;
        require!(d.attested_mask & bit == 0, SafeDealError::NotAllowed);
        d.attested_mask |= bit;
        d.attestations += 1;
        emit!(DeliveryAttested { id: d.id, oracle: ctx.accounts.oracle.key(), count: d.attestations });
        if d.attestations >= c.oracle_quorum {
            d.state = State::Delivered as u8;
            d.deadline = now + c.inspection_window;
            emit!(DealDelivered { id: d.id, deadline: d.deadline });
        }
        Ok(())
    }

    // ───────────────────────────── arbitrzy ─────────────────────────────

    /// Faza 1: arbiter zapisuje tylko hash głosu = sha256(id_le ‖ arbiter ‖ za_kupującym ‖ sól).
    /// Nikt — także inni arbitrzy — nie wie, jak zagłosował, więc nie da się dopasować do większości.
    pub fn commit_vote(ctx: Context<ArbiterAction>, commitment: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let idx = arbiter_index(c, &ctx.accounts.arbiter.key())?;
        let d = &mut ctx.accounts.deal;
        expect(d, State::InArbitration)?;
        require!(commitment != [0u8; 32], SafeDealError::InvalidParams);
        require!(now <= d.deadline - c.reveal_window, SafeDealError::DeadlinePassed);
        require!(d.commits[idx] == [0u8; 32], SafeDealError::NotAllowed);
        d.commits[idx] = commitment;
        d.commit_count += 1;
        emit!(VoteCommitted { id: d.id, arbiter: ctx.accounts.arbiter.key() });
        Ok(())
    }

    /// Faza 2: ujawnienie głosu. Otwiera się, gdy wszyscy złożyli głosy albo minęła faza 1.
    /// Gdy jedna strona zbierze kworum, program od razu wypłaca: zwycięzca dostaje kwotę i swoją
    /// kaucję, kaucja przegranego trafia do arbitrów, którzy głosowali za zwycięzcą.
    /// `remaining_accounts` = konta tokenowe arbitrów w kolejności z konfiguracji.
    pub fn reveal_vote<'info>(
        ctx: Context<'_, '_, 'info, 'info, Payout<'info>>,
        for_buyer: bool,
        salt: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let arbiter = ctx.accounts.actor.key();
        let idx = arbiter_index(&ctx.accounts.config, &arbiter)?;
        let reveal_window = ctx.accounts.config.reveal_window;
        let quorum = ctx.accounts.config.arbiter_quorum;
        let n_arb = ctx.accounts.config.arbiters.len();
        {
            let d = &mut ctx.accounts.deal;
            expect(d, State::InArbitration)?;
            require!(now <= d.deadline, SafeDealError::DeadlinePassed);
            let open = d.commit_count as usize >= n_arb || now > d.deadline - reveal_window;
            require!(open, SafeDealError::RevealNotOpen);
            require!(d.commits[idx] != [0u8; 32] && d.votes[idx] == 0, SafeDealError::NotAllowed);
            require!(d.commits[idx] == vote_commitment(d.id, &arbiter, for_buyer, &salt), SafeDealError::BadReveal);
            d.votes[idx] = if for_buyer { 1 } else { 2 };
            emit!(Voted { id: d.id, arbiter, for_buyer });
            if for_buyer {
                d.votes_buyer += 1;
            } else {
                d.votes_seller += 1;
            }
        }
        let a = ctx.accounts;
        if a.deal.votes_buyer >= quorum {
            resolve(a, ctx.remaining_accounts, true)?;
        } else if a.deal.votes_seller >= quorum {
            resolve(a, ctx.remaining_accounts, false)?;
        }
        Ok(())
    }

    // ───────────────────────────── wypłaty ─────────────────────────────

    /// Kupujący potwierdza odbiór — wypłata natychmiast, bez czekania na oracle i okno reklamacji.
    pub fn confirm_receipt(ctx: Context<Payout>) -> Result<()> {
        let a = ctx.accounts;
        require_keys_eq!(a.actor.key(), a.deal.buyer, SafeDealError::NotAllowed);
        let s = State::from_u8(a.deal.state);
        require!(s == State::Shipped || s == State::Delivered, SafeDealError::WrongState);
        release(a)
    }

    /// Sprzedawca podaje kod pokazany przez kupującego na spotkaniu — program sprawdza go z hashem
    /// zapisanym przy wpłacie i od razu wypłaca.
    pub fn confirm_pickup(ctx: Context<Payout>, code: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        expect(&a.deal, State::Funded)?;
        require_keys_eq!(a.actor.key(), a.deal.seller, SafeDealError::NotAllowed);
        require!(a.deal.pickup_hash != [0u8; 32], SafeDealError::NotAllowed);
        require!(
            hashv(&[a.deal.id.to_le_bytes().as_ref(), code.as_ref()]).to_bytes() == a.deal.pickup_hash,
            SafeDealError::BadReveal
        );
        require!(now <= a.deal.deadline, SafeDealError::DeadlinePassed);
        emit!(PickupConfirmed { id: a.deal.id });
        release(a)
    }

    /// Sprzedawca może w każdej chwili dobrowolnie oddać pieniądze (także uznając reklamację).
    pub fn refund_buyer(ctx: Context<Payout>) -> Result<()> {
        let a = ctx.accounts;
        require_keys_eq!(a.actor.key(), a.deal.seller, SafeDealError::NotAllowed);
        let s = State::from_u8(a.deal.state);
        require!(
            matches!(s, State::Funded | State::Shipped | State::Delivered | State::Disputed),
            SafeDealError::WrongState
        );
        let payout = a.deal.amount + if s == State::Disputed { a.deal.bond } else { 0 };
        if s == State::Disputed {
            rep_dispute(a, true);
        }
        pay(a, &a.buyer_ata, payout)?;
        close(&mut a.deal, State::Refunded);
        Ok(())
    }

    /// Strona proponuje podział, np. "oddaj mi 30%, rama jest porysowana". Nowa propozycja zastępuje
    /// poprzednią. Działa od nadania aż do werdyktu — także w trakcie sporu.
    pub fn propose_settlement(ctx: Context<PartyAction>, buyer_amount: u64) -> Result<()> {
        let me = ctx.accounts.actor.key();
        let d = &mut ctx.accounts.deal;
        require!(me == d.buyer || me == d.seller, SafeDealError::NotAllowed);
        require!(d.state >= State::Shipped as u8 && d.state <= State::InArbitration as u8, SafeDealError::WrongState);
        require!(buyer_amount <= d.amount, SafeDealError::InvalidParams);
        d.settlement_proposer = me;
        d.settlement_buyer_amount = buyer_amount;
        emit!(SettlementProposed { id: d.id, proposer: me, buyer_amount });
        Ok(())
    }

    /// Druga strona akceptuje. `buyer_amount` musi zgadzać się z propozycją — chroni przed podmianą
    /// oferty tuż przed akceptacją. Kaucje wracają do tych, którzy je wpłacili.
    pub fn accept_settlement(ctx: Context<Payout>, buyer_amount: u64) -> Result<()> {
        let a = ctx.accounts;
        let me = a.actor.key();
        let d = &a.deal;
        require!(me == d.buyer || me == d.seller, SafeDealError::NotAllowed);
        require!(
            d.settlement_proposer != Pubkey::default() && d.settlement_proposer != me,
            SafeDealError::NotAllowed
        );
        require!(d.settlement_buyer_amount == buyer_amount, SafeDealError::OfferMismatch);
        let s = State::from_u8(d.state);
        require!(d.state >= State::Shipped as u8 && d.state <= State::InArbitration as u8, SafeDealError::WrongState);
        let buyer_bond = if s == State::Disputed || s == State::InArbitration { d.bond } else { 0 };
        let seller_bond = if s == State::InArbitration { d.bond } else { 0 };
        let seller_amount = d.amount - buyer_amount;
        let id = d.id;
        pay(a, &a.buyer_ata, buyer_amount + buyer_bond)?;
        pay(a, &a.seller_ata, seller_amount + seller_bond)?;
        emit!(Settled { id, buyer_amount, seller_amount });
        a.deal.settlement_proposer = Pubkey::default();
        close(&mut a.deal, State::Settled);
        Ok(())
    }

    /// Każdy może "pchnąć" transakcję po upływie terminu. Wynik zależy tylko od stanu:
    /// nienadana → zwrot, w drodze / doręczona bez reklamacji → wypłata,
    /// sprzedawca zignorował spór → kupujący wygrywa, arbitrzy milczą → 50/50.
    pub fn settle_expired(ctx: Context<Payout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let s = State::from_u8(a.deal.state);
        require!(
            a.deal.state >= State::Funded as u8 && a.deal.state <= State::InArbitration as u8,
            SafeDealError::WrongState
        );
        require!(now > a.deal.deadline, SafeDealError::DeadlineNotReached);
        let (amount, bond) = (a.deal.amount, a.deal.bond);
        match s {
            State::Funded => {
                pay(a, &a.buyer_ata, amount)?;
                close(&mut a.deal, State::Refunded);
            }
            State::Shipped | State::Delivered => release(a)?,
            State::Disputed => {
                rep_dispute(a, true);
                pay(a, &a.buyer_ata, amount + bond)?;
                close(&mut a.deal, State::Refunded);
            }
            _ => {
                // Arbitraż bez rozstrzygnięcia: podział po połowie, kaucje wracają. Arbitrzy, którzy
                // nie ujawnili głosu, dostają odnotowaną nieobecność (podstawa do wymiany składu).
                for i in 0..a.config.arbiters.len() {
                    if a.deal.votes[i] == 0 {
                        a.config.arb_missed[i] += 1;
                    }
                }
                let half = amount / 2;
                pay(a, &a.buyer_ata, half + bond)?;
                pay(a, &a.seller_ata, amount - half + bond)?;
                close(&mut a.deal, State::Split);
            }
        }
        Ok(())
    }

    // ───────────────────────────── opinie i dowody ─────────────────────────────

    /// Opinia o drugiej stronie — tylko strony zamkniętej transakcji, w której przepłynęły pieniądze,
    /// raz. Liczy się też wolumen: farmienie opinii wymaga zamrożenia prawdziwych pieniędzy.
    pub fn review(ctx: Context<Review>, stars: u8, comment: String) -> Result<()> {
        let me = ctx.accounts.author.key();
        let d = &mut ctx.accounts.deal;
        let s = State::from_u8(d.state);
        require!(
            matches!(s, State::Released | State::Refunded | State::Split | State::Settled),
            SafeDealError::WrongState
        );
        require!((1..=5).contains(&stars) && comment.len() <= 280, SafeDealError::InvalidParams);
        let subject = if me == d.buyer {
            require!(!d.reviewed_by_buyer, SafeDealError::NotAllowed);
            d.reviewed_by_buyer = true;
            d.seller
        } else if me == d.seller {
            require!(!d.reviewed_by_seller, SafeDealError::NotAllowed);
            d.reviewed_by_seller = true;
            d.buyer
        } else {
            return err!(SafeDealError::NotAllowed);
        };
        require_keys_eq!(ctx.accounts.subject_profile.owner, subject, SafeDealError::NotAllowed);
        let p = &mut ctx.accounts.subject_profile;
        p.rating_count += 1;
        p.stars_sum += stars as u32;
        p.volume += d.amount;
        emit!(Reviewed { id: d.id, author: me, subject, stars, comment });
        Ok(())
    }

    /// Dowód (np. zdjęcie paczki): plik leży poza łańcuchem, on-chain trafia jego hash — podmiana
    /// pliku po fakcie jest natychmiast wykrywalna. Zapis w logu transakcji (zdarzenie).
    pub fn submit_evidence(ctx: Context<PartyAction>, uri: String, content_hash: [u8; 32], note: String) -> Result<()> {
        let me = ctx.accounts.actor.key();
        let d = &ctx.accounts.deal;
        require!(me == d.buyer || me == d.seller, SafeDealError::NotAllowed);
        require!(d.state >= State::Shipped as u8 && d.state <= State::InArbitration as u8, SafeDealError::WrongState);
        require!(uri.len() <= 200 && note.len() <= 280, SafeDealError::InvalidParams);
        emit!(Evidence { id: d.id, party: me, uri, content_hash, note });
        Ok(())
    }
}

// ───────────────────────────── logika wspólna ─────────────────────────────

fn expect(d: &Deal, s: State) -> Result<()> {
    require!(d.state == s as u8, SafeDealError::WrongState);
    Ok(())
}

fn close(d: &mut Deal, outcome: State) {
    d.state = outcome as u8;
    d.deadline = 0;
    emit!(DealClosed { id: d.id, outcome: outcome as u8 });
}

fn init_profile(p: &mut Account<Profile>, owner: Pubkey, bump: u8) {
    if p.owner == Pubkey::default() {
        p.owner = owner;
        p.bump = bump;
    }
}

fn arbiter_index(c: &Config, who: &Pubkey) -> Result<usize> {
    c.arbiters.iter().position(|a| a == who).ok_or(error!(SafeDealError::NotAllowed))
}

pub fn vote_commitment(id: u64, arbiter: &Pubkey, for_buyer: bool, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[id.to_le_bytes().as_ref(), arbiter.as_ref(), &[for_buyer as u8], salt.as_ref()]).to_bytes()
}

fn deposit<'info>(
    from: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    owner: &Signer<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to: vault.to_account_info(), authority: owner.to_account_info() },
        ),
        amount,
    )
}

/// Przelew z sejfu — podpisuje go PDA transakcji, czyli sam program. Żaden człowiek nie ma klucza.
fn pay_raw<'info>(
    deal: &Account<'info, Deal>,
    vault: &Account<'info, TokenAccount>,
    to: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let id = deal.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"deal", &id, &[deal.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: vault.to_account_info(), to: to.clone(), authority: deal.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

fn pay<'info>(a: &Payout<'info>, to: &Account<'info, TokenAccount>, amount: u64) -> Result<()> {
    pay_raw(&a.deal, &a.vault, &to.to_account_info(), &a.token_program, amount)
}

fn rep_dispute(a: &mut Payout, buyer_wins: bool) {
    if buyer_wins {
        a.buyer_profile.disputes_won += 1;
        a.seller_profile.disputes_lost += 1;
    } else {
        a.seller_profile.disputes_won += 1;
        a.buyer_profile.disputes_lost += 1;
    }
}

fn release(a: &mut Payout) -> Result<()> {
    a.seller_profile.sold_ok += 1;
    a.buyer_profile.bought_ok += 1;
    pay(a, &a.seller_ata, a.deal.amount)?;
    close(&mut a.deal, State::Released);
    Ok(())
}

fn resolve<'info>(a: &mut Payout<'info>, remaining: &'info [AccountInfo<'info>], buyer_wins: bool) -> Result<()> {
    let winning: u8 = if buyer_wins { 1 } else { 2 };
    let rewarded = if buyer_wins { a.deal.votes_buyer } else { a.deal.votes_seller } as u64;
    let (amount, bond) = (a.deal.amount, a.deal.bond);
    let share = bond / rewarded;
    let n = a.config.arbiters.len();
    require!(remaining.len() >= n, SafeDealError::InvalidParams);

    rep_dispute(a, buyer_wins);
    if !buyer_wins {
        a.seller_profile.sold_ok += 1;
        a.buyer_profile.bought_ok += 1;
    }

    // Zwycięzca: kwota + własna kaucja + reszta z dzielenia kaucji przegranego.
    let winner_ata = if buyer_wins { &a.buyer_ata } else { &a.seller_ata };
    pay(a, winner_ata, amount + bond + (bond - share * rewarded))?;

    // Kaucja przegranego trafia do arbitrów, którzy głosowali za zwycięzcą.
    for i in 0..n {
        let v = a.deal.votes[i];
        if v == winning {
            a.config.arb_with_majority[i] += 1;
            let acc = &remaining[i];
            let ta: Account<TokenAccount> = Account::try_from(acc)?;
            require!(ta.owner == a.config.arbiters[i] && ta.mint == a.config.mint, SafeDealError::InvalidParams);
            pay_raw(&a.deal, &a.vault, acc, &a.token_program, share)?;
        } else if v != 0 {
            a.config.arb_against_majority[i] += 1;
        } else if a.deal.commits[i] == [0u8; 32] {
            // Nie złożył głosu w fazie 1. Kto złożył, ale nie zdążył ujawnić przed rozstrzygnięciem
            // przez większość, nie jest karany — mógł ujawniać jako ostatni.
            a.config.arb_missed[i] += 1;
        }
    }
    close(&mut a.deal, if buyer_wins { State::Refunded } else { State::Released });
    Ok(())
}

// ───────────────────────────── konta ─────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    #[max_len(MAX_ORACLES)]
    pub oracles: Vec<Pubkey>,
    pub oracle_quorum: u8,
    #[max_len(MAX_ARBITERS)]
    pub arbiters: Vec<Pubkey>,
    pub arbiter_quorum: u8,
    pub ship_window: i64,
    pub transit_window: i64,
    pub inspection_window: i64,
    pub response_window: i64,
    pub arbitration_window: i64,
    pub reveal_window: i64,
    pub bond_bps: u16,
    pub deal_count: u64,
    /// Rzetelność arbitrów (indeksy jak w `arbiters`): zgodność z werdyktem i obecność.
    pub arb_with_majority: [u32; MAX_ARBITERS],
    pub arb_against_majority: [u32; MAX_ARBITERS],
    pub arb_missed: [u32; MAX_ARBITERS],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub id: u64,
    pub seller: Pubkey,
    /// Pubkey::default() = oferta otwarta, kupującym zostaje pierwszy, kto wpłaci.
    pub buyer: Pubkey,
    pub amount: u64,
    pub bond: u64,
    pub state: u8,
    pub deadline: i64,
    pub created_at: i64,
    #[max_len(80)]
    pub title: String,
    #[max_len(500)]
    pub description: String,
    #[max_len(200)]
    pub photo_uri: String,
    pub photo_hash: [u8; 32],
    #[max_len(120)]
    pub tracking: String,
    #[max_len(280)]
    pub dispute_reason: String,
    pub attestations: u8,
    pub attested_mask: u8,
    pub pickup_allowed: bool,
    pub pickup_hash: [u8; 32],
    pub settlement_proposer: Pubkey,
    pub settlement_buyer_amount: u64,
    pub commits: [[u8; 32]; MAX_ARBITERS],
    /// 0 = brak, 1 = za kupującym, 2 = za sprzedawcą (indeksy jak w `Config::arbiters`)
    pub votes: [u8; MAX_ARBITERS],
    pub commit_count: u8,
    pub votes_buyer: u8,
    pub votes_seller: u8,
    pub reviewed_by_buyer: bool,
    pub reviewed_by_seller: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub owner: Pubkey,
    pub sold_ok: u32,
    pub bought_ok: u32,
    pub disputes_won: u32,
    pub disputes_lost: u32,
    pub rating_count: u32,
    pub stars_sum: u32,
    pub volume: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitParams {
    pub oracles: Vec<Pubkey>,
    pub oracle_quorum: u8,
    pub arbiters: Vec<Pubkey>,
    pub arbiter_quorum: u8,
    pub ship_window: i64,
    pub transit_window: i64,
    pub inspection_window: i64,
    pub response_window: i64,
    pub arbitration_window: i64,
    pub reveal_window: i64,
    pub bond_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateDealArgs {
    pub amount: u64,
    pub title: String,
    pub buyer: Option<Pubkey>,
    pub description: String,
    pub photo_uri: String,
    pub photo_hash: [u8; 32],
    pub pickup_allowed: bool,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA, które jest mint authority testowego tokenu
    #[account(seeds = [b"mint_auth"], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user)]
    pub user_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = seller,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", (config.deal_count + 1).to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,
    /// Sejf: konto tokenowe, którego właścicielem jest PDA transakcji (nie człowiek).
    #[account(
        init,
        payer = seller,
        seeds = [b"vault", deal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = deal
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = seller,
        space = 8 + Profile::INIT_SPACE,
        seeds = [b"profile", seller.key().as_ref()],
        bump
    )]
    pub seller_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellerAction<'info> {
    pub seller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct PartyAction<'info> {
    pub actor: Signer<'info>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct OracleAction<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct ArbiterAction<'info> {
    pub arbiter: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, token::authority = buyer)]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + Profile::INIT_SPACE,
        seeds = [b"profile", buyer.key().as_ref()],
        bump
    )]
    pub buyer_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Strona wpłaca kaucję (reklamacja / odpowiedź na reklamację).
#[derive(Accounts)]
pub struct PartyDeposit<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, token::authority = actor)]
    pub actor_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Wszystko, co może wypłacić pieniądze z sejfu. Konta odbiorców są przypięte do adresów zapisanych
/// w transakcji — wywołujący nie może podstawić własnego konta.
#[derive(Accounts)]
pub struct Payout<'info> {
    pub actor: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, constraint = buyer_ata.owner == deal.buyer @ SafeDealError::NotAllowed)]
    pub buyer_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, constraint = seller_ata.owner == deal.seller @ SafeDealError::NotAllowed)]
    pub seller_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"profile", deal.buyer.as_ref()], bump = buyer_profile.bump)]
    pub buyer_profile: Account<'info, Profile>,
    #[account(mut, seeds = [b"profile", deal.seller.as_ref()], bump = seller_profile.bump)]
    pub seller_profile: Account<'info, Profile>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Review<'info> {
    pub author: Signer<'info>,
    #[account(mut, seeds = [b"deal", deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [b"profile", subject_profile.owner.as_ref()], bump = subject_profile.bump)]
    pub subject_profile: Account<'info, Profile>,
}

// ───────────────────────────── zdarzenia ─────────────────────────────

#[event]
pub struct DealCreated { pub id: u64, pub seller: Pubkey, pub buyer: Pubkey, pub amount: u64, pub title: String }
#[event]
pub struct DealFunded { pub id: u64, pub buyer: Pubkey, pub deadline: i64 }
#[event]
pub struct DealShipped { pub id: u64, pub tracking: String, pub deadline: i64 }
#[event]
pub struct DeliveryAttested { pub id: u64, pub oracle: Pubkey, pub count: u8 }
#[event]
pub struct DealDelivered { pub id: u64, pub deadline: i64 }
#[event]
pub struct DisputeOpened { pub id: u64, pub reason: String, pub deadline: i64 }
#[event]
pub struct ArbitrationStarted { pub id: u64, pub deadline: i64 }
#[event]
pub struct VoteCommitted { pub id: u64, pub arbiter: Pubkey }
#[event]
pub struct Voted { pub id: u64, pub arbiter: Pubkey, pub for_buyer: bool }
#[event]
pub struct DealClosed { pub id: u64, pub outcome: u8 }
#[event]
pub struct SettlementProposed { pub id: u64, pub proposer: Pubkey, pub buyer_amount: u64 }
#[event]
pub struct Settled { pub id: u64, pub buyer_amount: u64, pub seller_amount: u64 }
#[event]
pub struct PickupConfirmed { pub id: u64 }
#[event]
pub struct Reviewed { pub id: u64, pub author: Pubkey, pub subject: Pubkey, pub stars: u8, pub comment: String }
#[event]
pub struct Evidence { pub id: u64, pub party: Pubkey, pub uri: String, pub content_hash: [u8; 32], pub note: String }

#[error_code]
pub enum SafeDealError {
    #[msg("Ta osoba nie może wykonać tej akcji.")]
    NotAllowed,
    #[msg("Termin na tę akcję już minął.")]
    DeadlinePassed,
    #[msg("Termin jeszcze nie minął.")]
    DeadlineNotReached,
    #[msg("Transakcja jest w innym stanie.")]
    WrongState,
    #[msg("Nieprawidłowe dane.")]
    InvalidParams,
    #[msg("Ujawnianie głosów jeszcze się nie zaczęło.")]
    RevealNotOpen,
    #[msg("Ujawniony głos nie zgadza się z wcześniejszym hashem.")]
    BadReveal,
    #[msg("Propozycja ugody właśnie się zmieniła — sprawdź nową kwotę.")]
    OfferMismatch,
}
