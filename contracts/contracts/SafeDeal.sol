// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SafeDeal — escrow dla transakcji między obcymi ludźmi
/// @notice Kupujący wpłaca środki do kontraktu, sprzedawca wysyła paczkę, oracle potwierdza
///         doręczenie, a po oknie reklamacyjnym środki same trafiają do sprzedawcy.
///         Każdy stan nieterminalny ma deadline, po którym `settleExpired` rozstrzyga sprawę
///         deterministycznie — żadna strona nie może "zamrozić" pieniędzy znikając.
contract SafeDeal is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Created, //       oferta czeka na kupującego
        Funded, //        środki zablokowane, czekamy na nadanie        → timeout: zwrot kupującemu
        Shipped, //       paczka w drodze                               → timeout: wypłata sprzedawcy
        Delivered, //     oracle: doręczono, trwa okno reklamacji       → timeout: wypłata sprzedawcy
        Disputed, //      kupujący otworzył spór (z kaucją)             → timeout: kupujący wygrywa
        InArbitration, // obie strony wpłaciły kaucję, głosują arbitrzy → timeout: podział 50/50
        Released, //      ✔ sprzedawca dostał pieniądze
        Refunded, //      ✔ kupujący dostał zwrot
        Split, //         ✔ arbitraż nie zapadł — podział po połowie
        Cancelled, //     ✔ oferta anulowana przed wpłatą
        Settled //        ✔ ugoda — strony same uzgodniły podział
    }

    struct Deal {
        address seller;
        address buyer;
        uint128 amount;
        uint128 bond;
        State state;
        uint64 deadline;
        uint64 createdAt;
        uint8 votesBuyer;
        uint8 votesSeller;
        string title;
        string tracking;
    }

    struct Reputation {
        uint32 soldOk;
        uint32 boughtOk;
        uint32 disputesWon;
        uint32 disputesLost;
    }

    /// @dev Rzetelność arbitra: zgodność z werdyktem i obecność. Podstawa do wymiany składu puli.
    struct ArbiterStats {
        uint32 withMajority;
        uint32 againstMajority;
        uint32 missed; // nie złożył głosu albo nie ujawnił go na czas
    }

    IERC20 public immutable token;
    uint64 public immutable shipWindow;
    uint64 public immutable transitWindow;
    uint64 public immutable inspectionWindow;
    uint64 public immutable responseWindow;
    uint64 public immutable arbitrationWindow; // faza 1: niejawne głosy (commit)
    uint64 public immutable revealWindow; //      faza 2: ujawnianie głosów (reveal)
    uint16 public immutable bondBps;
    uint64 public immutable adminDelay; // ile czeka zapowiedziana zmiana oracle'i/arbitrów
    uint128 public immutable arbiterStake; // kaucja za wejście do puli arbitrów
    uint16 public immutable missPenaltyBps; // jaka część kaucji przepada za nieoddany głos

    uint8 public constant PANEL_SIZE = 3;
    /// @dev Losowanie przegląda całą pulę — limit chroni przed zapchaniem jej kontami tak, by arbitraż
    ///      przekroczył limit gazu i nikt nie mógł odpowiedzieć na reklamację.
    uint16 public constant MAX_POOL = 200;

    /// @dev Niezależne źródła statusu przesyłki (np. API przewoźnika, drugi przewoźnik, Chainlink DON).
    ///      Doręczenie liczy się dopiero po `oracleQuorum` zgodnych potwierdzeniach.
    address[] public oracles;
    uint8 public oracleQuorum;
    mapping(uint256 => mapping(address => bool)) public attestedBy;
    mapping(uint256 => uint8) public attestations;

    address[] public arbiters;
    uint8 public quorum;

    uint256 public dealCount;
    mapping(uint256 => Deal) private _deals;
    /// @dev 0 = brak głosu, 1 = za kupującym, 2 = za sprzedawcą
    mapping(uint256 => mapping(address => uint8)) public voteOf;
    /// @dev keccak256(abi.encode(id, arbiter, forBuyer, salt)) — głos ukryty do fazy ujawniania
    mapping(uint256 => mapping(address => bytes32)) public commitOf;
    mapping(uint256 => uint8) public commitCount;
    mapping(uint256 => address[]) private _revealed;
    mapping(address => Reputation) public reputation;
    mapping(address => ArbiterStats) public arbiterStats;

    /// @dev Opinie: tylko strony zamkniętej transakcji, raz, o drugiej stronie. Nie da się ich kupić ani usunąć.
    struct Rating {
        uint32 count;
        uint32 starsSum;
        uint128 volume; // łączna kwota transakcji, za które wystawiono opinie — farmienie opinii wymaga zamrożenia prawdziwych pieniędzy
    }
    mapping(address => Rating) public ratings;

    /// @dev Odbiór osobisty: kupujący przy wpłacie zapisuje hash tajnego kodu. Pokazuje kod na spotkaniu,
    ///      dopiero po obejrzeniu przedmiotu — sprzedawca podaje go kontraktowi i dostaje zapłatę.
    mapping(uint256 => bool) public pickupAllowed;
    mapping(uint256 => bytes32) public pickupHash;
    mapping(uint256 => mapping(address => bool)) public reviewed;

    /// @dev Aktualna propozycja ugody: ile z kwoty transakcji wraca do kupującego (reszta → sprzedawca).
    struct SettlementOffer {
        address proposer;
        uint128 buyerAmount;
    }
    mapping(uint256 => SettlementOffer) public settlementOf;

    struct PendingSet {
        address[] members;
        uint8 quorum;
        uint64 effectiveAt;
    }
    PendingSet private _pendingOracles;
    PendingSet private _pendingArbiters;

    /// @dev Pula arbitrów: każdy może dołączyć, wpłacając kaucję. Skład do sprawy jest losowany z puli.
    address[] private _pool;
    mapping(address => uint256) private _poolIndex; // 1-based; 0 = poza pulą
    mapping(address => uint128) public stakeOf;
    mapping(address => uint32) public activeCases;

    /// @dev Skład arbitrów konkretnej sprawy — zamrożony w chwili przejścia do arbitrażu.
    mapping(uint256 => address[]) private _panel;
    mapping(uint256 => uint8) public panelQuorum;
    mapping(uint256 => bool) public panelFromPool;

    event DealCreated(uint256 indexed id, address indexed seller, address indexed buyer, uint256 amount, string title);
    event DealFunded(uint256 indexed id, address indexed buyer, uint64 shipDeadline);
    event DealShipped(uint256 indexed id, string tracking, uint64 deadline);
    event DealDelivered(uint256 indexed id, uint64 inspectionDeadline);
    event DisputeOpened(uint256 indexed id, string reason, uint64 responseDeadline);
    event ArbitrationStarted(uint256 indexed id, uint64 arbitrationDeadline);
    event VoteCommitted(uint256 indexed id, address indexed arbiter);
    event Voted(uint256 indexed id, address indexed arbiter, bool forBuyer);
    event DealClosed(uint256 indexed id, State outcome);
    event Evidence(uint256 indexed id, address indexed party, string uri, bytes32 contentHash, string note);
    event SettlementProposed(uint256 indexed id, address indexed proposer, uint128 buyerAmount);
    event Settled(uint256 indexed id, uint128 buyerAmount, uint128 sellerAmount);
    event Listing(uint256 indexed id, string description, string photoUri, bytes32 photoHash);
    event Reviewed(uint256 indexed id, address indexed author, address indexed subject, uint8 stars, string comment);
    event PickupAllowed(uint256 indexed id, bool allowed);
    event PickupConfirmed(uint256 indexed id);
    event DeliveryAttested(uint256 indexed id, address indexed oracle, uint8 count);
    event OraclesChanged(address[] oracles, uint8 quorum);
    event ArbitersChanged(address[] arbiters, uint8 quorum);
    event OraclesChangeScheduled(address[] oracles, uint8 quorum, uint64 effectiveAt);
    event ArbitersChangeScheduled(address[] arbiters, uint8 quorum, uint64 effectiveAt);
    event PendingCancelled();
    event PoolJoined(address indexed arbiter, uint128 stake);
    event PoolLeft(address indexed arbiter, uint128 stake);
    event PanelDrawn(uint256 indexed id, address[] panel, bool fromPool);
    event Slashed(uint256 indexed id, address indexed arbiter, uint128 amount);

    error WrongState(State expected, State actual);
    error NotAllowed();
    error DeadlinePassed();
    error DeadlineNotReached();
    error InvalidParams();
    error RevealNotOpen();
    error BadReveal();
    error OfferMismatch();

    struct Config {
        uint64 shipWindow;
        uint64 transitWindow;
        uint64 inspectionWindow;
        uint64 responseWindow;
        uint64 arbitrationWindow;
        uint64 revealWindow;
        uint64 adminDelay;
        uint128 arbiterStake;
        uint16 missPenaltyBps;
        uint16 bondBps;
    }

    constructor(
        IERC20 token_,
        address[] memory oracles_,
        uint8 oracleQuorum_,
        address[] memory arbiters_,
        uint8 quorum_,
        Config memory cfg
    ) Ownable(msg.sender) {
        if (cfg.bondBps > 10_000) revert InvalidParams();
        token = token_;
        shipWindow = cfg.shipWindow;
        transitWindow = cfg.transitWindow;
        inspectionWindow = cfg.inspectionWindow;
        responseWindow = cfg.responseWindow;
        arbitrationWindow = cfg.arbitrationWindow;
        revealWindow = cfg.revealWindow;
        bondBps = cfg.bondBps;
        adminDelay = cfg.adminDelay;
        if (cfg.missPenaltyBps > 10_000) revert InvalidParams();
        arbiterStake = cfg.arbiterStake;
        missPenaltyBps = cfg.missPenaltyBps;
        _setOracles(oracles_, oracleQuorum_);
        _setArbiters(arbiters_, quorum_);
    }

    // ───────────────────────────── sprzedawca ─────────────────────────────

    /// @param buyer konkretny kupujący albo address(0) — oferta otwarta dla każdego
    function createDeal(uint128 amount, string calldata title, address buyer) external returns (uint256 id) {
        if (amount == 0 || buyer == msg.sender) revert InvalidParams();
        id = ++dealCount;
        Deal storage d = _deals[id];
        d.seller = msg.sender;
        d.buyer = buyer;
        d.amount = amount;
        d.state = State.Created;
        d.createdAt = uint64(block.timestamp);
        d.title = title;
        emit DealCreated(id, msg.sender, buyer, amount, title);
    }

    /// @notice Opis i zdjęcie oferty. Można je zmieniać tylko do wpłaty — potem to, co kupujący
    ///         widział przy zakupie (łącznie z hashem zdjęcia), jest zamrożone i służy jako dowód w sporze.
    function describe(uint256 id, string calldata description, string calldata photoUri, bytes32 photoHash) external {
        Deal storage d = _deals[id];
        _expect(d, State.Created);
        if (msg.sender != d.seller) revert NotAllowed();
        emit Listing(id, description, photoUri, photoHash);
    }

    function cancel(uint256 id) external {
        Deal storage d = _deals[id];
        _expect(d, State.Created);
        if (msg.sender != d.seller) revert NotAllowed();
        _close(id, d, State.Cancelled);
    }

    function markShipped(uint256 id, string calldata tracking) external {
        Deal storage d = _deals[id];
        _expect(d, State.Funded);
        if (msg.sender != d.seller || pickupHash[id] != 0) revert NotAllowed();
        if (block.timestamp > d.deadline) revert DeadlinePassed();
        d.tracking = tracking;
        d.state = State.Shipped;
        d.deadline = uint64(block.timestamp) + transitWindow + inspectionWindow;
        emit DealShipped(id, tracking, d.deadline);
    }

    /// @notice Sprzedawca może w każdej chwili dobrowolnie oddać pieniądze (także zamykając spór).
    function refundBuyer(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.seller) revert NotAllowed();
        State s = d.state;
        if (s != State.Funded && s != State.Shipped && s != State.Delivered && s != State.Disputed) {
            revert WrongState(State.Funded, s);
        }
        uint256 payout = d.amount + (s == State.Disputed ? d.bond : 0);
        if (s == State.Disputed) _repDispute(d.buyer, d.seller);
        _close(id, d, State.Refunded);
        token.safeTransfer(d.buyer, payout);
    }

    function respondToDispute(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        _expect(d, State.Disputed);
        if (msg.sender != d.seller) revert NotAllowed();
        if (block.timestamp > d.deadline) revert DeadlinePassed();
        d.state = State.InArbitration;
        // deadline = koniec fazy ujawniania; koniec fazy commit = deadline - revealWindow
        d.deadline = uint64(block.timestamp) + arbitrationWindow + revealWindow;
        _drawPanel(id, d);
        token.safeTransferFrom(msg.sender, address(this), d.bond);
        emit ArbitrationStarted(id, d.deadline);
    }

    // ───────────────────────────── kupujący ─────────────────────────────

    function fund(uint256 id) external nonReentrant {
        _fund(id, _deals[id]);
    }

    /// @notice Zakup z odbiorem osobistym. `codeHash` = keccak256(abi.encode(id, code)), gdzie `code`
    ///         zna tylko kupujący. Termin na spotkanie to `shipWindow` — potem pieniądze same wracają.
    function fundPickup(uint256 id, bytes32 codeHash) external nonReentrant {
        Deal storage d = _deals[id];
        if (!pickupAllowed[id] || codeHash == bytes32(0)) revert NotAllowed();
        pickupHash[id] = codeHash;
        _fund(id, d);
    }

    function _fund(uint256 id, Deal storage d) private {
        _expect(d, State.Created);
        if (msg.sender == d.seller) revert NotAllowed();
        if (d.buyer != address(0) && d.buyer != msg.sender) revert NotAllowed();
        d.buyer = msg.sender;
        d.state = State.Funded;
        d.deadline = uint64(block.timestamp) + shipWindow;
        token.safeTransferFrom(msg.sender, address(this), d.amount);
        emit DealFunded(id, msg.sender, d.deadline);
    }

    /// @notice Kupujący potwierdza odbiór — wypłata natychmiast, bez czekania na oracle i okno reklamacji.
    function confirmReceipt(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotAllowed();
        if (d.state != State.Shipped && d.state != State.Delivered) revert WrongState(State.Delivered, d.state);
        _release(id, d);
    }

    function openDispute(uint256 id, string calldata reason) external nonReentrant {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotAllowed();
        if (d.state != State.Shipped && d.state != State.Delivered) revert WrongState(State.Delivered, d.state);
        if (block.timestamp > d.deadline) revert DeadlinePassed();
        uint128 bond = uint128((uint256(d.amount) * bondBps) / 10_000);
        d.bond = bond;
        d.state = State.Disputed;
        d.deadline = uint64(block.timestamp) + responseWindow;
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit DisputeOpened(id, reason, d.deadline);
    }

    // ───────────────────────────── ugoda ─────────────────────────────

    /// @notice Strona proponuje podział, np. "oddaj mi 30%, rama jest porysowana". Nowa propozycja
    ///         zastępuje poprzednią. Działa od nadania aż do werdyktu — także w trakcie sporu.
    function proposeSettlement(uint256 id, uint128 buyerAmount) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotAllowed();
        if (d.state < State.Shipped || d.state > State.InArbitration) revert WrongState(State.Delivered, d.state);
        if (buyerAmount > d.amount) revert InvalidParams();
        settlementOf[id] = SettlementOffer(msg.sender, buyerAmount);
        emit SettlementProposed(id, msg.sender, buyerAmount);
    }

    /// @notice Druga strona akceptuje. `buyerAmount` musi zgadzać się z propozycją — chroni przed
    ///         podmianą oferty tuż przed akceptacją. Kaucje wracają do tych, którzy je wpłacili.
    function acceptSettlement(uint256 id, uint128 buyerAmount) external nonReentrant {
        Deal storage d = _deals[id];
        SettlementOffer memory o = settlementOf[id];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotAllowed();
        if (o.proposer == address(0) || o.proposer == msg.sender) revert NotAllowed();
        if (o.buyerAmount != buyerAmount) revert OfferMismatch();
        State s = d.state;
        if (s < State.Shipped || s > State.InArbitration) revert WrongState(State.Delivered, s);

        uint256 buyerBond = s >= State.Disputed ? d.bond : 0;
        uint256 sellerBond = s == State.InArbitration ? d.bond : 0;
        uint128 sellerAmount = d.amount - buyerAmount;
        delete settlementOf[id];
        if (s == State.InArbitration) _releasePanel(id);
        _close(id, d, State.Settled);
        emit Settled(id, buyerAmount, sellerAmount);

        if (buyerAmount + buyerBond > 0) token.safeTransfer(d.buyer, buyerAmount + buyerBond);
        if (sellerAmount + sellerBond > 0) token.safeTransfer(d.seller, sellerAmount + sellerBond);
    }

    // ───────────────────────────── odbiór osobisty ─────────────────────────────

    function setPickup(uint256 id, bool allowed) external {
        Deal storage d = _deals[id];
        _expect(d, State.Created);
        if (msg.sender != d.seller) revert NotAllowed();
        pickupAllowed[id] = allowed;
        emit PickupAllowed(id, allowed);
    }

    /// @notice Sprzedawca podaje kod pokazany przez kupującego na spotkaniu — kontrakt od razu wypłaca.
    function confirmPickup(uint256 id, bytes32 code) external nonReentrant {
        Deal storage d = _deals[id];
        _expect(d, State.Funded);
        if (msg.sender != d.seller || pickupHash[id] == 0) revert NotAllowed();
        if (keccak256(abi.encode(id, code)) != pickupHash[id]) revert BadReveal();
        if (block.timestamp > d.deadline) revert DeadlinePassed();
        emit PickupConfirmed(id);
        _release(id, d);
    }

    function pickupCodeHash(uint256 id, bytes32 code) external pure returns (bytes32) {
        return keccak256(abi.encode(id, code));
    }

    // ───────────────────────────── opinie ─────────────────────────────

    /// @notice Opinia o drugiej stronie — możliwa dopiero po zamknięciu transakcji, w której przepłynęły pieniądze.
    function review(uint256 id, uint8 stars, string calldata comment) external {
        Deal storage d = _deals[id];
        State s = d.state;
        if (s != State.Released && s != State.Refunded && s != State.Split && s != State.Settled) {
            revert WrongState(State.Released, s);
        }
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotAllowed();
        if (stars < 1 || stars > 5 || bytes(comment).length > 280) revert InvalidParams();
        if (reviewed[id][msg.sender]) revert NotAllowed();
        reviewed[id][msg.sender] = true;

        address subject = msg.sender == d.buyer ? d.seller : d.buyer;
        Rating storage r = ratings[subject];
        r.count++;
        r.starsSum += stars;
        r.volume += d.amount;
        emit Reviewed(id, msg.sender, subject, stars, comment);
    }

    // ───────────────────────────── dowody ─────────────────────────────

    /// @notice Strona dołącza dowód (np. zdjęcie paczki). Plik leży poza łańcuchem (IPFS / storage),
    ///         a on-chain trafia jego hash — podmiana pliku po fakcie jest natychmiast wykrywalna.
    function submitEvidence(uint256 id, string calldata uri, bytes32 contentHash, string calldata note) external {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotAllowed();
        if (d.state < State.Shipped || d.state > State.InArbitration) revert WrongState(State.Disputed, d.state);
        emit Evidence(id, msg.sender, uri, contentHash, note);
    }

    // ───────────────────────────── oracle ─────────────────────────────

    /// @notice Oracle potwierdza status "doręczono". Stan zmienia się dopiero, gdy `oracleQuorum`
    ///         niezależnych źródeł się zgodzi — pojedyncze przekupione lub zepsute źródło nie wystarczy.
    function confirmDelivery(uint256 id) external {
        if (!isOracle(msg.sender)) revert NotAllowed();
        Deal storage d = _deals[id];
        _expect(d, State.Shipped);
        if (attestedBy[id][msg.sender]) revert NotAllowed();
        attestedBy[id][msg.sender] = true;
        uint8 count = ++attestations[id];
        emit DeliveryAttested(id, msg.sender, count);
        if (count < oracleQuorum) return;

        d.state = State.Delivered;
        d.deadline = uint64(block.timestamp) + inspectionWindow;
        emit DealDelivered(id, d.deadline);
    }

    // ───────────────────────────── arbitrzy ─────────────────────────────

    /// @notice Faza 1: arbiter zapisuje tylko hash głosu. Nikt — także inni arbitrzy — nie wie,
    ///         jak zagłosował, więc nie da się "dopasować" do większości ani przekupić pod wynik.
    function commitVote(uint256 id, bytes32 commitment) external {
        if (!onPanel(id, msg.sender) || commitment == bytes32(0)) revert NotAllowed();
        Deal storage d = _deals[id];
        _expect(d, State.InArbitration);
        if (block.timestamp > d.deadline - revealWindow) revert DeadlinePassed();
        if (commitOf[id][msg.sender] != 0) revert NotAllowed();
        commitOf[id][msg.sender] = commitment;
        commitCount[id]++;
        emit VoteCommitted(id, msg.sender);
    }

    /// @notice Faza 2: ujawnienie głosu. Otwiera się, gdy wszyscy arbitrzy złożyli głosy
    ///         albo minął czas fazy 1. Głos musi zgadzać się z wcześniejszym hashem.
    function revealVote(uint256 id, bool forBuyer, bytes32 salt) external nonReentrant {
        Deal storage d = _deals[id];
        _expect(d, State.InArbitration);
        if (block.timestamp > d.deadline) revert DeadlinePassed();
        if (!revealOpen(id)) revert RevealNotOpen();
        bytes32 c = commitOf[id][msg.sender];
        if (c == 0 || voteOf[id][msg.sender] != 0) revert NotAllowed();
        if (c != voteCommitment(id, msg.sender, forBuyer, salt)) revert BadReveal();
        voteOf[id][msg.sender] = forBuyer ? 1 : 2;
        _revealed[id].push(msg.sender);
        emit Voted(id, msg.sender, forBuyer);

        uint8 q = panelQuorum[id];
        if (forBuyer && ++d.votesBuyer >= q) _resolve(id, d, true);
        else if (!forBuyer && ++d.votesSeller >= q) _resolve(id, d, false);
    }

    // ───────────────────────────── pula arbitrów ─────────────────────────────

    /// @notice Każdy może zostać arbitrem — wpłaca kaucję, którą częściowo traci, jeśli wylosowany nie zagłosuje.
    function joinPool() external nonReentrant {
        if (_poolIndex[msg.sender] != 0 || _pool.length >= MAX_POOL) revert NotAllowed();
        _pool.push(msg.sender);
        _poolIndex[msg.sender] = _pool.length;
        stakeOf[msg.sender] = arbiterStake;
        token.safeTransferFrom(msg.sender, address(this), arbiterStake);
        emit PoolJoined(msg.sender, arbiterStake);
    }

    /// @notice Wyjście z puli z resztą kaucji — tylko bez otwartych spraw.
    function leavePool() external nonReentrant {
        uint256 idx = _poolIndex[msg.sender];
        if (idx == 0 || activeCases[msg.sender] != 0) revert NotAllowed();
        address last = _pool[_pool.length - 1];
        _pool[idx - 1] = last;
        _poolIndex[last] = idx;
        _pool.pop();
        delete _poolIndex[msg.sender];
        uint128 stake = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        if (stake > 0) token.safeTransfer(msg.sender, stake);
        emit PoolLeft(msg.sender, stake);
    }

    // ───────────────────────────── timeouty ─────────────────────────────

    /// @notice Każdy może "pchnąć" transakcję po upływie deadline'u. Wynik zależy tylko od stanu:
    ///         nienadana → zwrot, w drodze / doręczona bez reklamacji → wypłata,
    ///         sprzedawca zignorował spór → kupujący wygrywa, arbitrzy milczą → 50/50.
    function settleExpired(uint256 id) external nonReentrant {
        Deal storage d = _deals[id];
        State s = d.state;
        if (s < State.Funded || s > State.InArbitration) revert WrongState(State.Funded, s);
        if (block.timestamp <= d.deadline) revert DeadlineNotReached();

        if (s == State.Funded) {
            _close(id, d, State.Refunded);
            token.safeTransfer(d.buyer, d.amount);
        } else if (s == State.Shipped || s == State.Delivered) {
            _release(id, d);
        } else if (s == State.Disputed) {
            _repDispute(d.buyer, d.seller);
            _close(id, d, State.Refunded);
            token.safeTransfer(d.buyer, uint256(d.amount) + d.bond);
        } else {
            uint256 half = d.amount / 2;
            uint256 penalties;
            address[] storage panel = _panel[id];
            for (uint256 i; i < panel.length; ++i) {
                if (voteOf[id][panel[i]] == 0) {
                    arbiterStats[panel[i]].missed++;
                    penalties += _slash(id, panel[i]);
                }
            }
            _releasePanel(id);
            _close(id, d, State.Split);
            token.safeTransfer(d.buyer, half + d.bond + penalties / 2);
            token.safeTransfer(d.seller, d.amount - half + d.bond + (penalties - penalties / 2));
        }
    }

    // ───────────────────────────── admin ─────────────────────────────

    // Zmiany oracle'i i arbitrów wchodzą dopiero po `adminDelay` i są publicznie zapowiadane zdarzeniem.
    // Właściciel nie może z dnia na dzień podstawić siebie jako jedynego oracle'a ani wymienić arbitrów
    // pod konkretny spór — każdy zdąży zobaczyć zmianę i zamknąć swoje transakcje.

    function setOracles(address[] calldata oracles_, uint8 quorum_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > oracles_.length) revert InvalidParams();
        _pendingOracles = PendingSet(oracles_, quorum_, uint64(block.timestamp) + adminDelay);
        emit OraclesChangeScheduled(oracles_, quorum_, _pendingOracles.effectiveAt);
    }

    function setArbiters(address[] calldata arbiters_, uint8 quorum_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > arbiters_.length) revert InvalidParams();
        _pendingArbiters = PendingSet(arbiters_, quorum_, uint64(block.timestamp) + adminDelay);
        emit ArbitersChangeScheduled(arbiters_, quorum_, _pendingArbiters.effectiveAt);
    }

    /// @notice Po upływie opóźnienia każdy może wprowadzić zapowiedzianą zmianę.
    function applyOracles() external {
        PendingSet memory p = _pendingOracles;
        if (p.effectiveAt == 0) revert NotAllowed();
        if (block.timestamp < p.effectiveAt) revert DeadlineNotReached();
        delete _pendingOracles;
        _setOracles(p.members, p.quorum);
    }

    function applyArbiters() external {
        PendingSet memory p = _pendingArbiters;
        if (p.effectiveAt == 0) revert NotAllowed();
        if (block.timestamp < p.effectiveAt) revert DeadlineNotReached();
        delete _pendingArbiters;
        _setArbiters(p.members, p.quorum);
    }

    /// @notice Właściciel może wycofać zapowiedzianą zmianę (np. pomyłkę) — wycofanie niczego nie zmienia od razu.
    function cancelPending() external onlyOwner {
        delete _pendingOracles;
        delete _pendingArbiters;
        emit PendingCancelled();
    }

    function pendingOracles() external view returns (address[] memory members, uint8 quorum_, uint64 effectiveAt) {
        return (_pendingOracles.members, _pendingOracles.quorum, _pendingOracles.effectiveAt);
    }

    function pendingArbiters() external view returns (address[] memory members, uint8 quorum_, uint64 effectiveAt) {
        return (_pendingArbiters.members, _pendingArbiters.quorum, _pendingArbiters.effectiveAt);
    }

    // ───────────────────────────── widoki ─────────────────────────────

    function getDeal(uint256 id) external view returns (Deal memory) {
        return _deals[id];
    }

    function getArbiters() external view returns (address[] memory) {
        return arbiters;
    }

    function getPanel(uint256 id) external view returns (address[] memory) {
        return _panel[id];
    }

    function getPool() external view returns (address[] memory) {
        return _pool;
    }

    function inPool(address a) external view returns (bool) {
        return _poolIndex[a] != 0;
    }

    function onPanel(uint256 id, address a) public view returns (bool) {
        address[] storage p = _panel[id];
        for (uint256 i; i < p.length; ++i) {
            if (p[i] == a) return true;
        }
        return false;
    }

    function getOracles() external view returns (address[] memory) {
        return oracles;
    }

    function isOracle(address a) public view returns (bool) {
        for (uint256 i; i < oracles.length; ++i) {
            if (oracles[i] == a) return true;
        }
        return false;
    }

    function isArbiter(address a) public view returns (bool) {
        for (uint256 i; i < arbiters.length; ++i) {
            if (arbiters[i] == a) return true;
        }
        return false;
    }

    function voteCommitment(uint256 id, address arbiter, bool forBuyer, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, arbiter, forBuyer, salt));
    }

    function revealOpen(uint256 id) public view returns (bool) {
        Deal storage d = _deals[id];
        if (d.state != State.InArbitration) return false;
        return commitCount[id] >= _panel[id].length || block.timestamp > d.deadline - revealWindow;
    }

    function bondFor(uint256 id) external view returns (uint256) {
        return (uint256(_deals[id].amount) * bondBps) / 10_000;
    }

    // ───────────────────────────── wewnętrzne ─────────────────────────────

    function _release(uint256 id, Deal storage d) private {
        reputation[d.seller].soldOk++;
        reputation[d.buyer].boughtOk++;
        _close(id, d, State.Released);
        token.safeTransfer(d.seller, d.amount);
    }

    /// @dev Zwycięzca dostaje kwotę transakcji (kupujący — zwrot, sprzedawca — zapłatę) i swoją kaucję.
    ///      Kaucja przegranego trafia do arbitrów, którzy głosowali za zwycięzcą — uczciwy głos się opłaca.
    function _resolve(uint256 id, Deal storage d, bool buyerWins) private {
        (address winner, address loser) = buyerWins ? (d.buyer, d.seller) : (d.seller, d.buyer);
        uint8 winningVote = buyerWins ? 1 : 2;
        uint256 rewarded = buyerWins ? d.votesBuyer : d.votesSeller;
        uint256 share = d.bond / rewarded;

        _repDispute(winner, loser);
        if (!buyerWins) {
            reputation[d.seller].soldOk++;
            reputation[d.buyer].boughtOk++;
        }
        _close(id, d, buyerWins ? State.Refunded : State.Released);

        // Nieobecność: kto z wylosowanego składu nie złożył głosu w fazie 1. Kto złożył, ale nie zdążył
        // ujawnić przed rozstrzygnięciem przez większość, nie jest karany — mógł ujawniać jako ostatni.
        uint256 penalties;
        address[] storage panel = _panel[id];
        for (uint256 i; i < panel.length; ++i) {
            address a = panel[i];
            if (commitOf[id][a] == 0 && voteOf[id][a] == 0) {
                arbiterStats[a].missed++;
                penalties += _slash(id, a);
            }
        }
        _releasePanel(id);

        token.safeTransfer(winner, uint256(d.amount) + d.bond + (d.bond - share * rewarded) + penalties);
        // Nagradzamy według listy ujawnionych głosów, a nie bieżącej puli — arbiter usunięty w trakcie
        // sporu i tak dostaje swój udział, więc żadne środki nie zostają zablokowane w kontrakcie.
        address[] storage voters = _revealed[id];
        for (uint256 i; i < voters.length; ++i) {
            address a = voters[i];
            if (voteOf[id][a] == winningVote) {
                arbiterStats[a].withMajority++;
                token.safeTransfer(a, share);
            } else {
                arbiterStats[a].againstMajority++;
            }
        }
    }

    /// @dev Losuje PANEL_SIZE arbitrów z puli (bez stron sporu). Gdy pula jest za mała, sprawę dostaje
    ///      rada arbitrów (zmiany z timelockiem). Skład jest zamrażany — późniejsze zmiany go nie dotyczą.
    ///      Losowość z prevrandao wystarcza na MVP; docelowo Chainlink VRF (patrz README).
    function _drawPanel(uint256 id, Deal storage d) private {
        address[] memory candidates = new address[](_pool.length);
        uint256 n;
        for (uint256 i; i < _pool.length; ++i) {
            address a = _pool[i];
            if (a != d.buyer && a != d.seller) candidates[n++] = a;
        }

        address[] storage panel = _panel[id];
        if (n >= PANEL_SIZE) {
            uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, block.timestamp, id, n)));
            for (uint256 k; k < PANEL_SIZE; ++k) {
                uint256 j = k + (uint256(keccak256(abi.encode(seed, k))) % (n - k)); // częściowy Fisher–Yates
                (candidates[k], candidates[j]) = (candidates[j], candidates[k]);
                panel.push(candidates[k]);
                activeCases[candidates[k]]++;
            }
            panelQuorum[id] = PANEL_SIZE / 2 + 1;
            panelFromPool[id] = true;
        } else {
            for (uint256 i; i < arbiters.length; ++i) panel.push(arbiters[i]);
            panelQuorum[id] = quorum;
        }
        emit PanelDrawn(id, panel, panelFromPool[id]);
    }

    function _releasePanel(uint256 id) private {
        if (!panelFromPool[id]) return;
        address[] storage panel = _panel[id];
        for (uint256 i; i < panel.length; ++i) {
            if (activeCases[panel[i]] > 0) activeCases[panel[i]]--;
        }
    }

    function _slash(uint256 id, address a) private returns (uint256 penalty) {
        if (!panelFromPool[id]) return 0;
        penalty = (uint256(stakeOf[a]) * missPenaltyBps) / 10_000;
        if (penalty == 0) return 0;
        stakeOf[a] -= uint128(penalty);
        emit Slashed(id, a, uint128(penalty));
    }

    function _repDispute(address winner, address loser) private {
        reputation[winner].disputesWon++;
        reputation[loser].disputesLost++;
    }

    function _close(uint256 id, Deal storage d, State outcome) private {
        d.state = outcome;
        d.deadline = 0;
        emit DealClosed(id, outcome);
    }

    function _expect(Deal storage d, State s) private view {
        if (d.state != s) revert WrongState(s, d.state);
    }

    function _setArbiters(address[] memory arbiters_, uint8 quorum_) private {
        if (quorum_ == 0 || quorum_ > arbiters_.length) revert InvalidParams();
        arbiters = arbiters_;
        quorum = quorum_;
        emit ArbitersChanged(arbiters_, quorum_);
    }

    function _setOracles(address[] memory oracles_, uint8 quorum_) private {
        if (quorum_ == 0 || quorum_ > oracles_.length) revert InvalidParams();
        oracles = oracles_;
        oracleQuorum = quorum_;
        emit OraclesChanged(oracles_, quorum_);
    }
}
