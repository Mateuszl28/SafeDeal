//! SafeDeal — escrow dla transakcji między obcymi ludźmi, na Solanie.
//!
//! Kupujący wpłaca tokeny do sejfu (konto tokenowe, którego właścicielem jest PDA transakcji — nie
//! człowiek), sprzedawca wysyła paczkę, niezależne oracle potwierdzają doręczenie, a po oknie
//! reklamacyjnym pieniądze trafiają do sprzedawcy. Każdy stan nieterminalny ma deadline, po którym
//! `settle_expired` (może je wywołać KAŻDY) rozstrzyga sprawę deterministycznie — żadna strona nie
//! może zamrozić pieniędzy, znikając.
//!
//! Spory rozstrzygają arbitrzy z otwartej puli: każdy może do niej dołączyć, wpłacając kaucję.
//! Skład (3 osoby) do konkretnego sporu losuje program z hasha slotu, który powstaje dopiero po
//! zgłoszeniu sporu — nikt (także strony) nie wybiera arbitrów. Arbiter, który nie zagłosuje, traci
//! część kaucji (spalana — nikt na niej nie zarabia).
//!
//! Po rozliczeniu każdy może zamknąć konta transakcji: rent wraca do sprzedawcy, który za nie zapłacił,
//! a pełny opis transakcji zostaje w zdarzeniu `DealArchived` w historii łańcucha.
//!
//! Brak instrukcji administracyjnych: parametry (token, oracle, terminy, kaucje) zapisuje
//! `initialize` raz i na zawsze. Nikt — także autor — nie może ich później zmienić ani wypłacić
//! cudzych środków z sejfu.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use solana_sha256_hasher::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Eo9CXiAbBVBE5megSiY8H67c91qP3BZ8NjWgQvu9EzRZ");

pub const MAX_ORACLES: usize = 5;
/// Liczba arbitrów losowanych do jednego sporu.
pub const PANEL: usize = 3;
/// Maksymalna liczba arbitrów w puli.
pub const MAX_POOL: usize = 32;
/// Losowanie składu używa hasha slotu, który powstanie co najmniej tyle slotów po zgłoszeniu.
pub const DRAW_DELAY: u64 = 2;
/// Ile tokenów (w najmniejszych jednostkach) wydaje kran testowego USDC — 1000 przy 6 miejscach.
pub const FAUCET_AMOUNT: u64 = 1_000_000_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const DEAL_SEED: &[u8] = b"deal";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const ARBITER_SEED: &[u8] = b"arbiter";

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

/// Werdykt arbitrażu — od niego zależy rozliczenie każdego arbitra ze składu.
pub const VERDICT_NONE: u8 = 0; // strony zawarły ugodę albo spór nie trafił do arbitrów
pub const VERDICT_BUYER: u8 = 1;
pub const VERDICT_SELLER: u8 = 2;
pub const VERDICT_SPLIT: u8 = 3; // arbitrzy nie rozstrzygnęli w terminie

#[program]
pub mod safedeal {
    use super::*;

    // ───────────────────────────── konfiguracja (raz) ─────────────────────────────

    /// Jednorazowo zapisuje reguły gry i zakłada pustą pulę arbitrów. Nie ma instrukcji, która
    /// mogłaby je zmienić.
    pub fn initialize(ctx: Context<Initialize>, p: InitParams) -> Result<()> {
        require!(
            p.oracles.len() <= MAX_ORACLES
                && p.oracle_quorum >= 1
                && p.oracle_quorum as usize <= p.oracles.len()
                && p.arbiter_quorum as usize > PANEL / 2
                && p.arbiter_quorum as usize <= PANEL
                && p.arbiter_stake > 0
                && p.miss_slash <= p.arbiter_stake
                && p.bond_bps <= 10_000,
            SafeDealError::InvalidParams
        );
        let c = &mut ctx.accounts.config;
        c.mint = ctx.accounts.mint.key();
        c.oracles = p.oracles;
        c.oracle_quorum = p.oracle_quorum;
        c.arbiter_quorum = p.arbiter_quorum;
        c.arbiter_stake = p.arbiter_stake;
        c.miss_slash = p.miss_slash;
        c.ship_window = p.ship_window;
        c.transit_window = p.transit_window;
        c.inspection_window = p.inspection_window;
        c.response_window = p.response_window;
        c.arbitration_window = p.arbitration_window;
        c.reveal_window = p.reveal_window;
        c.archive_window = p.archive_window;
        c.bond_bps = p.bond_bps;
        c.deal_count = 0;
        c.bump = ctx.bumps.config;
        let pool = &mut ctx.accounts.pool;
        pool.members = Vec::new();
        pool.bump = ctx.bumps.pool;
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

    // ───────────────────────────── pula arbitrów ─────────────────────────────

    /// Każdy może zostać arbitrem: wpłaca kaucję do sejfu puli. Kaucja to koszt wejścia (przejęcie
    /// składu wymaga wielu kaucji) i zabezpieczenie na wypadek nieobecności.
    pub fn join_pool(ctx: Context<JoinPool>, stake: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(stake >= c.arbiter_stake, SafeDealError::InvalidParams);
        let me = ctx.accounts.owner.key();
        let pool = &mut ctx.accounts.pool;
        require!(pool.members.len() < MAX_POOL, SafeDealError::PoolFull);
        let a = &mut ctx.accounts.arbiter;
        require!(!a.in_pool, SafeDealError::NotAllowed);
        if a.owner == Pubkey::default() {
            a.owner = me;
            a.bump = ctx.bumps.arbiter;
        }
        a.in_pool = true;
        a.stake += stake;
        pool.members.push(me);
        let total = a.stake;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            stake,
        )?;
        emit!(ArbiterJoined { arbiter: me, stake: total });
        Ok(())
    }

    /// Arbiter wychodzi z puli i odbiera kaucję — tylko gdy nie ma żadnej nierozliczonej sprawy.
    pub fn leave_pool(ctx: Context<LeavePool>) -> Result<()> {
        let me = ctx.accounts.owner.key();
        let a = &mut ctx.accounts.arbiter;
        require!(a.active_cases == 0, SafeDealError::ArbiterBusy);
        require!(a.stake > 0 || a.in_pool, SafeDealError::NotAllowed);
        let amount = a.stake;
        a.stake = 0;
        a.in_pool = false;
        let pool = &mut ctx.accounts.pool;
        if let Some(i) = pool.members.iter().position(|m| *m == me) {
            pool.members.swap_remove(i);
        }
        let seeds: &[&[u8]] = &[POOL_SEED, &[pool.bump]];
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: ctx.accounts.owner_ata.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;
        }
        emit!(ArbiterLeft { arbiter: me, stake: amount });
        Ok(())
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
        close(d, State::Cancelled)
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

    /// Sprzedawca idzie do arbitrażu: wpłaca taką samą kaucję jak kupujący. Skład arbitrów zostanie
    /// wylosowany z hasha slotu, który jeszcze nie istnieje (`draw_slot`) — strona nie może dobrać
    /// momentu wywołania tak, żeby trafić na „swoich” arbitrów.
    pub fn respond_to_dispute(ctx: Context<PartyDeposit>) -> Result<()> {
        let clock = Clock::get()?;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        expect(d, State::Disputed)?;
        require_keys_eq!(ctx.accounts.actor.key(), d.seller, SafeDealError::NotAllowed);
        require!(clock.unix_timestamp <= d.deadline, SafeDealError::DeadlinePassed);
        d.state = State::InArbitration as u8;
        d.draw_slot = clock.slot + DRAW_DELAY;
        // Termin liczony od nowa po losowaniu; gdyby nikt nie wylosował składu — podział 50/50.
        d.deadline = clock.unix_timestamp + c.arbitration_window + c.reveal_window;
        let bond = d.bond;
        let (id, deadline, draw_slot) = (d.id, d.deadline, d.draw_slot);
        deposit(&ctx.accounts.actor_ata, &ctx.accounts.vault, &ctx.accounts.actor, &ctx.accounts.token_program, bond)?;
        emit!(ArbitrationStarted { id, deadline, draw_slot });
        Ok(())
    }

    // ───────────────────────────── losowanie składu ─────────────────────────────

    /// Losuje 3 arbitrów z puli (bez stron sporu). Źródło losowości: hash pierwszego slotu ≥
    /// `draw_slot` z sysvaru SlotHashes — nieznany w chwili, gdy sprzedawca przyjął spór.
    /// Może wywołać każdy. `remaining_accounts` = konta wylosowanych arbitrów w kolejności losowania
    /// (klient liczy je tym samym algorytmem); program sprawdza każdy adres.
    /// Gdy slot wypadł już z historii (~3 min), losowanie przesuwa się na nowy przyszły slot.
    pub fn draw_panel<'info>(ctx: Context<'_, '_, 'info, 'info, DrawPanel<'info>>) -> Result<()> {
        let clock = Clock::get()?;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        expect(d, State::InArbitration)?;
        require!(!d.panel_drawn, SafeDealError::NotAllowed);
        require!(clock.unix_timestamp <= d.deadline, SafeDealError::DeadlinePassed);
        require!(clock.slot > d.draw_slot, SafeDealError::DrawNotReady);

        let Some(seed_hash) = slot_hash_at_or_after(&ctx.accounts.slot_hashes, d.draw_slot)? else {
            d.draw_slot = clock.slot + DRAW_DELAY;
            emit!(DrawRescheduled { id: d.id, draw_slot: d.draw_slot });
            return Ok(());
        };
        let panel = pick_panel(&ctx.accounts.pool.members, d.id, &seed_hash, &d.buyer, &d.seller)?;
        require!(ctx.remaining_accounts.len() >= PANEL, SafeDealError::InvalidParams);
        for (j, who) in panel.iter().enumerate() {
            let acc = &ctx.remaining_accounts[j];
            let (expected, _) = Pubkey::find_program_address(&[ARBITER_SEED, who.as_ref()], &crate::ID);
            require_keys_eq!(acc.key(), expected, SafeDealError::InvalidParams);
            let mut a: Account<Arbiter> = Account::try_from(acc)?;
            a.active_cases += 1;
            a.cases += 1;
            a.exit(&crate::ID)?;
        }
        d.panel = panel;
        d.panel_drawn = true;
        d.deadline = clock.unix_timestamp + c.arbitration_window + c.reveal_window;
        emit!(PanelDrawn { id: d.id, panel, deadline: d.deadline });
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

    /// Faza 1: arbiter ze składu zapisuje tylko hash głosu = sha256(id_le ‖ arbiter ‖ za_kupującym ‖ sól).
    /// Nikt — także inni arbitrzy — nie wie, jak zagłosował, więc nie da się dopasować do większości.
    pub fn commit_vote(ctx: Context<ArbiterAction>, commitment: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        expect(d, State::InArbitration)?;
        let idx = panel_index(d, &ctx.accounts.arbiter.key())?;
        require!(commitment != [0u8; 32], SafeDealError::InvalidParams);
        require!(now <= d.deadline - c.reveal_window, SafeDealError::DeadlinePassed);
        require!(d.commits[idx] == [0u8; 32], SafeDealError::NotAllowed);
        d.commits[idx] = commitment;
        d.commit_count += 1;
        emit!(VoteCommitted { id: d.id, arbiter: ctx.accounts.arbiter.key() });
        Ok(())
    }

    /// Faza 2: ujawnienie głosu. Otwiera się, gdy cały skład złożył głosy albo minęła faza 1.
    /// Gdy jedna strona zbierze kworum, program od razu wypłaca zwycięzcy kwotę i jego kaucję;
    /// kaucja przegranego czeka w sejfie na arbitrów, którzy głosowali za zwycięzcą (`settle_arbiter`).
    pub fn reveal_vote(ctx: Context<Payout>, for_buyer: bool, salt: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let arbiter = ctx.accounts.actor.key();
        let reveal_window = ctx.accounts.config.reveal_window;
        let quorum = ctx.accounts.config.arbiter_quorum;
        {
            let d = &mut ctx.accounts.deal;
            expect(d, State::InArbitration)?;
            let idx = panel_index(d, &arbiter)?;
            require!(now <= d.deadline, SafeDealError::DeadlinePassed);
            let open = d.commit_count as usize >= PANEL || now > d.deadline - reveal_window;
            require!(open, SafeDealError::RevealNotOpen);
            require!(d.commits[idx] != [0u8; 32] && d.votes[idx] == 0, SafeDealError::NotAllowed);
            require!(d.commits[idx] == vote_commitment(d.id, &arbiter, for_buyer, &salt), SafeDealError::BadReveal);
            d.votes[idx] = if for_buyer { VERDICT_BUYER } else { VERDICT_SELLER };
            emit!(Voted { id: d.id, arbiter, for_buyer });
            if for_buyer {
                d.votes_buyer += 1;
            } else {
                d.votes_seller += 1;
            }
        }
        let a = ctx.accounts;
        if a.deal.votes_buyer >= quorum {
            resolve(a, true)?;
        } else if a.deal.votes_seller >= quorum {
            resolve(a, false)?;
        }
        Ok(())
    }

    /// Rozliczenie jednego arbitra ze składu po zamknięciu sporu (może wywołać każdy): nagroda z kaucji
    /// przegranego dla głosujących za zwycięzcą, kara (spalenie części kaucji) dla nieobecnych,
    /// statystyki rzetelności i zwolnienie sprawy, żeby arbiter mógł wyjść z puli.
    pub fn settle_arbiter(ctx: Context<SettleArbiter>, index: u8) -> Result<()> {
        let i = index as usize;
        require!(i < PANEL, SafeDealError::InvalidParams);
        let c = &ctx.accounts.config;
        let d = &mut ctx.accounts.deal;
        require!(is_closed(d.state) && d.panel_drawn, SafeDealError::WrongState);
        require!(d.panel_settled & (1 << i) == 0, SafeDealError::NotAllowed);
        require_keys_eq!(ctx.accounts.arbiter.owner, d.panel[i], SafeDealError::InvalidParams);
        require_keys_eq!(ctx.accounts.arbiter_ata.owner, d.panel[i], SafeDealError::NotAllowed);
        d.panel_settled |= 1 << i;

        let vote = d.votes[i];
        let mut reward = 0u64;
        let mut missed = false;
        let a = &mut ctx.accounts.arbiter;
        match d.verdict {
            VERDICT_BUYER | VERDICT_SELLER => {
                if vote == d.verdict {
                    a.with_majority += 1;
                    reward = d.reward_share;
                } else if vote != 0 {
                    a.against_majority += 1;
                } else if d.commits[i] == [0u8; 32] {
                    // Nie złożył głosu w fazie 1. Kto złożył, ale nie zdążył ujawnić przed werdyktem
                    // większości, nie jest karany — mógł ujawniać jako ostatni.
                    missed = true;
                }
            }
            VERDICT_SPLIT => missed = vote == 0,
            _ => {}
        }
        a.active_cases = a.active_cases.saturating_sub(1);
        let mut slashed = 0u64;
        if missed {
            a.missed += 1;
            slashed = c.miss_slash.min(a.stake);
            a.stake -= slashed;
        }
        let drop_out = a.in_pool && a.stake < c.arbiter_stake;
        if drop_out {
            a.in_pool = false;
        }
        let who = a.owner;

        if reward > 0 {
            pay_raw(d, &ctx.accounts.vault, &ctx.accounts.arbiter_ata.to_account_info(), &ctx.accounts.token_program, reward)?;
        }
        let pool = &mut ctx.accounts.pool;
        if drop_out {
            if let Some(p) = pool.members.iter().position(|m| *m == who) {
                pool.members.swap_remove(p);
            }
        }
        if slashed > 0 {
            let seeds: &[&[u8]] = &[POOL_SEED, &[pool.bump]];
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.pool_vault.to_account_info(),
                        authority: pool.to_account_info(),
                    },
                    &[seeds],
                ),
                slashed,
            )?;
        }
        emit!(ArbiterSettled { id: d.id, arbiter: who, reward, slashed, removed: drop_out });
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
        close(&mut a.deal, State::Refunded)
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
        a.deal.verdict = VERDICT_NONE;
        close(&mut a.deal, State::Settled)
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
                close(&mut a.deal, State::Refunded)?;
            }
            State::Shipped | State::Delivered => release(a)?,
            State::Disputed => {
                rep_dispute(a, true);
                pay(a, &a.buyer_ata, amount + bond)?;
                close(&mut a.deal, State::Refunded)?;
            }
            _ => {
                // Arbitraż bez rozstrzygnięcia: podział po połowie, kaucje wracają. Arbitrzy ze składu,
                // którzy nie ujawnili głosu, tracą część kaucji przy `settle_arbiter`.
                let half = amount / 2;
                pay(a, &a.buyer_ata, half + bond)?;
                pay(a, &a.seller_ata, amount - half + bond)?;
                a.deal.verdict = VERDICT_SPLIT;
                close(&mut a.deal, State::Split)?;
            }
        }
        Ok(())
    }

    // ───────────────────────────── zamknięcie kont ─────────────────────────────

    /// Porządki po rozliczeniu (może wywołać każdy): zamyka sejf i konto transakcji, a rent wraca do
    /// sprzedawcy, który za nie zapłacił — adres jest przypięty, wywołujący nie może go podmienić.
    /// Warunki: transakcja zamknięta, arbitrzy rozliczeni, obie opinie wystawione albo minęło okno
    /// na opinie. Pełny opis zostaje w zdarzeniu `DealArchived` (historia łańcucha).
    pub fn close_deal(ctx: Context<CloseDeal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        let d = &ctx.accounts.deal;
        require!(is_closed(d.state), SafeDealError::WrongState);
        let all = (1u8 << PANEL) - 1;
        require!(!d.panel_drawn || d.panel_settled == all, SafeDealError::ArbitersNotSettled);
        let reviews_done = d.state == State::Cancelled as u8 || (d.reviewed_by_buyer && d.reviewed_by_seller);
        require!(reviews_done || now > d.closed_at + c.archive_window, SafeDealError::DeadlineNotReached);

        // Ewentualne tokeny wpłacone do sejfu z zewnątrz (nie mogą zablokować zamknięcia) → sprzedawca.
        let leftover = ctx.accounts.vault.amount;
        if leftover > 0 {
            pay_raw(d, &ctx.accounts.vault, &ctx.accounts.seller_ata.to_account_info(), &ctx.accounts.token_program, leftover)?;
        }
        let id = d.id.to_le_bytes();
        let seeds: &[&[u8]] = &[DEAL_SEED, &id, &[d.bump]];
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: d.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(DealArchived {
            id: d.id,
            seller: d.seller,
            buyer: d.buyer,
            amount: d.amount,
            bond: d.bond,
            state: d.state,
            created_at: d.created_at,
            closed_at: d.closed_at,
            title: d.title.clone(),
            description: d.description.clone(),
            photo_uri: d.photo_uri.clone(),
            photo_hash: d.photo_hash,
            tracking: d.tracking.clone(),
            dispute_reason: d.dispute_reason.clone(),
            pickup: d.pickup_hash != [0u8; 32],
            panel: d.panel,
            votes: d.votes,
        });
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

fn is_closed(state: u8) -> bool {
    state >= State::Released as u8 && state <= State::Settled as u8
}

fn close(d: &mut Deal, outcome: State) -> Result<()> {
    d.state = outcome as u8;
    d.deadline = 0;
    d.closed_at = Clock::get()?.unix_timestamp;
    emit!(DealClosed { id: d.id, outcome: outcome as u8 });
    Ok(())
}

fn init_profile(p: &mut Account<Profile>, owner: Pubkey, bump: u8) {
    if p.owner == Pubkey::default() {
        p.owner = owner;
        p.bump = bump;
    }
}

fn panel_index(d: &Deal, who: &Pubkey) -> Result<usize> {
    require!(d.panel_drawn, SafeDealError::NotAllowed);
    d.panel.iter().position(|a| a == who).ok_or(error!(SafeDealError::NotAllowed))
}

pub fn vote_commitment(id: u64, arbiter: &Pubkey, for_buyer: bool, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[id.to_le_bytes().as_ref(), arbiter.as_ref(), &[for_buyer as u8], salt.as_ref()]).to_bytes()
}

/// Hash najwcześniejszego slotu ≥ `target` z sysvaru SlotHashes (wpisy od najnowszego). `None`, gdy
/// historia nie sięga już `target` — wtedy nie da się udowodnić, który slot był pierwszy.
fn slot_hash_at_or_after(sysvar: &AccountInfo, target: u64) -> Result<Option<[u8; 32]>> {
    let data = sysvar.try_borrow_data()?;
    require!(data.len() >= 8, SafeDealError::InvalidParams);
    let n = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
    let mut found: Option<[u8; 32]> = None;
    for i in 0..n {
        let off = 8 + i * 40;
        if off + 40 > data.len() {
            break;
        }
        let slot = u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        if slot < target {
            return Ok(found);
        }
        found = Some(data[off + 8..off + 40].try_into().unwrap());
    }
    // Doszliśmy do końca historii bez slotu < target — wcześniejszy slot ≥ target mógł z niej wypaść.
    Ok(None)
}

/// Deterministyczne losowanie składu: dla j = 0..PANEL indeks = sha256(seed ‖ id ‖ j) mod liczba
/// kandydatów, bez powtórzeń. Kandydaci = pula bez kupującego i sprzedawcy, w kolejności z puli.
pub fn pick_panel(members: &[Pubkey], id: u64, seed: &[u8; 32], buyer: &Pubkey, seller: &Pubkey) -> Result<[Pubkey; PANEL]> {
    let mut cand: Vec<Pubkey> = members.iter().filter(|m| *m != buyer && *m != seller).copied().collect();
    require!(cand.len() >= PANEL, SafeDealError::PoolTooSmall);
    let mut panel = [Pubkey::default(); PANEL];
    for (j, slot) in panel.iter_mut().enumerate() {
        let h = hashv(&[seed.as_ref(), id.to_le_bytes().as_ref(), &[j as u8]]).to_bytes();
        let r = u64::from_le_bytes(h[0..8].try_into().unwrap()) as usize % cand.len();
        *slot = cand.remove(r);
    }
    Ok(panel)
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
    let seeds: &[&[u8]] = &[DEAL_SEED, &id, &[deal.bump]];
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
    close(&mut a.deal, State::Released)
}

/// Werdykt większości: zwycięzca dostaje kwotę, własną kaucję i resztę z dzielenia kaucji
/// przegranego; udziały arbitrów zostają w sejfie do `settle_arbiter`.
fn resolve(a: &mut Payout, buyer_wins: bool) -> Result<()> {
    let rewarded = if buyer_wins { a.deal.votes_buyer } else { a.deal.votes_seller } as u64;
    let (amount, bond) = (a.deal.amount, a.deal.bond);
    let share = bond / rewarded;

    rep_dispute(a, buyer_wins);
    if !buyer_wins {
        a.seller_profile.sold_ok += 1;
        a.buyer_profile.bought_ok += 1;
    }
    let winner_ata = if buyer_wins { &a.buyer_ata } else { &a.seller_ata };
    pay(a, winner_ata, amount + bond + (bond - share * rewarded))?;
    a.deal.reward_share = share;
    a.deal.verdict = if buyer_wins { VERDICT_BUYER } else { VERDICT_SELLER };
    close(&mut a.deal, if buyer_wins { State::Refunded } else { State::Released })
}

// ───────────────────────────── konta ─────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    #[max_len(MAX_ORACLES)]
    pub oracles: Vec<Pubkey>,
    pub oracle_quorum: u8,
    /// Ile zgodnych głosów (z `PANEL`) rozstrzyga spór.
    pub arbiter_quorum: u8,
    /// Minimalna kaucja arbitra w puli.
    pub arbiter_stake: u64,
    /// Kara (spalana z kaucji) za nieoddanie głosu w wylosowanej sprawie.
    pub miss_slash: u64,
    pub ship_window: i64,
    pub transit_window: i64,
    pub inspection_window: i64,
    pub response_window: i64,
    pub arbitration_window: i64,
    pub reveal_window: i64,
    /// Po tym czasie od zamknięcia konta transakcji można zamknąć bez kompletu opinii.
    pub archive_window: i64,
    pub bond_bps: u16,
    pub deal_count: u64,
    pub bump: u8,
}

/// Otwarta pula arbitrów — każdy z kaucją może dołączyć; z niej losowany jest skład do sporu.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    #[max_len(MAX_POOL)]
    pub members: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Arbiter {
    pub owner: Pubkey,
    pub stake: u64,
    pub in_pool: bool,
    /// Wylosowane, jeszcze nierozliczone sprawy — do zera nie można wyjść z puli.
    pub active_cases: u16,
    pub cases: u32,
    pub with_majority: u32,
    pub against_majority: u32,
    pub missed: u32,
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
    pub closed_at: i64,
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
    /// Slot, którego hash wylosuje skład arbitrów.
    pub draw_slot: u64,
    pub panel_drawn: bool,
    pub panel: [Pubkey; PANEL],
    /// Bity: którzy arbitrzy ze składu zostali już rozliczeni (`settle_arbiter`).
    pub panel_settled: u8,
    pub commits: [[u8; 32]; PANEL],
    /// 0 = brak, 1 = za kupującym, 2 = za sprzedawcą (indeksy jak w `panel`)
    pub votes: [u8; PANEL],
    pub commit_count: u8,
    pub votes_buyer: u8,
    pub votes_seller: u8,
    pub verdict: u8,
    /// Udział każdego arbitra głosującego za zwycięzcą w kaucji przegranego.
    pub reward_share: u64,
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
    pub arbiter_quorum: u8,
    pub arbiter_stake: u64,
    pub miss_slash: u64,
    pub ship_window: i64,
    pub transit_window: i64,
    pub inspection_window: i64,
    pub response_window: i64,
    pub arbitration_window: i64,
    pub reveal_window: i64,
    pub archive_window: i64,
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
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = payer, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED], bump)]
    pub pool: Account<'info, Pool>,
    /// Sejf kaucji arbitrów — właścicielem jest PDA puli, nie człowiek.
    #[account(init, payer = payer, seeds = [POOL_VAULT_SEED], bump, token::mint = mint, token::authority = pool)]
    pub pool_vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)]
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
pub struct JoinPool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POOL_VAULT_SEED], bump)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Arbiter::INIT_SPACE,
        seeds = [ARBITER_SEED, owner.key().as_ref()],
        bump
    )]
    pub arbiter: Account<'info, Arbiter>,
    #[account(mut, token::mint = config.mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LeavePool<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POOL_VAULT_SEED], bump)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [ARBITER_SEED, owner.key().as_ref()], bump = arbiter.bump, has_one = owner)]
    pub arbiter: Account<'info, Arbiter>,
    #[account(mut, token::mint = config.mint, token::authority = owner)]
    pub owner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CreateDeal<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = seller,
        space = 8 + Deal::INIT_SPACE,
        seeds = [DEAL_SEED, (config.deal_count + 1).to_le_bytes().as_ref()],
        bump
    )]
    pub deal: Account<'info, Deal>,
    /// Sejf: konto tokenowe, którego właścicielem jest PDA transakcji (nie człowiek).
    #[account(
        init,
        payer = seller,
        seeds = [VAULT_SEED, deal.key().as_ref()],
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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct PartyAction<'info> {
    pub actor: Signer<'info>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct OracleAction<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct ArbiterAction<'info> {
    pub arbiter: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct DrawPanel<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    /// CHECK: sysvar SlotHashes (adres sprawdzony), czytany ręcznie — jest za duży na deserializację.
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleArbiter<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [POOL_VAULT_SEED], bump)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [VAULT_SEED, deal.key().as_ref()], bump = deal.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [ARBITER_SEED, arbiter.owner.as_ref()], bump = arbiter.bump)]
    pub arbiter: Account<'info, Arbiter>,
    #[account(mut, token::mint = config.mint)]
    pub arbiter_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseDeal<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = seller, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump, has_one = seller)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [VAULT_SEED, deal.key().as_ref()], bump = deal.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: odbiorca rentu — przypięty do sprzedawcy zapisanego w transakcji (`has_one`).
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.mint, constraint = seller_ata.owner == deal.seller @ SafeDealError::NotAllowed)]
    pub seller_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [VAULT_SEED, deal.key().as_ref()], bump = deal.vault_bump)]
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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [VAULT_SEED, deal.key().as_ref()], bump = deal.vault_bump)]
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
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, Deal>,
    #[account(mut, seeds = [VAULT_SEED, deal.key().as_ref()], bump = deal.vault_bump)]
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
    #[account(mut, seeds = [DEAL_SEED, deal.id.to_le_bytes().as_ref()], bump = deal.bump)]
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
pub struct ArbitrationStarted { pub id: u64, pub deadline: i64, pub draw_slot: u64 }
#[event]
pub struct DrawRescheduled { pub id: u64, pub draw_slot: u64 }
#[event]
pub struct PanelDrawn { pub id: u64, pub panel: [Pubkey; PANEL], pub deadline: i64 }
#[event]
pub struct VoteCommitted { pub id: u64, pub arbiter: Pubkey }
#[event]
pub struct Voted { pub id: u64, pub arbiter: Pubkey, pub for_buyer: bool }
#[event]
pub struct ArbiterSettled { pub id: u64, pub arbiter: Pubkey, pub reward: u64, pub slashed: u64, pub removed: bool }
#[event]
pub struct ArbiterJoined { pub arbiter: Pubkey, pub stake: u64 }
#[event]
pub struct ArbiterLeft { pub arbiter: Pubkey, pub stake: u64 }
#[event]
pub struct DealClosed { pub id: u64, pub outcome: u8 }
#[event]
pub struct DealArchived {
    pub id: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub bond: u64,
    pub state: u8,
    pub created_at: i64,
    pub closed_at: i64,
    pub title: String,
    pub description: String,
    pub photo_uri: String,
    pub photo_hash: [u8; 32],
    pub tracking: String,
    pub dispute_reason: String,
    pub pickup: bool,
    pub panel: [Pubkey; PANEL],
    pub votes: [u8; PANEL],
}
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
    #[msg("Losowanie arbitrów będzie możliwe za chwilę (czekamy na przyszły slot).")]
    DrawNotReady,
    #[msg("W puli jest za mało arbitrów, żeby wylosować skład.")]
    PoolTooSmall,
    #[msg("Pula arbitrów jest pełna.")]
    PoolFull,
    #[msg("Arbiter ma nierozliczone sprawy.")]
    ArbiterBusy,
    #[msg("Najpierw trzeba rozliczyć arbitrów tej sprawy.")]
    ArbitersNotSettled,
}
