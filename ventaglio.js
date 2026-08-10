/*  ventaglio.js — il ventaglio a mano, generico.  v1.3
    Estratto da Scala Quaranta (js/sq-hand.js), ripulito da qualunque idea di
    seme, rango, carta o regola. Qui dentro non si sa cosa siano gli elementi:
    il gioco passa i suoi dati e una funzione che li disegna, il ventaglio ci
    mette GEOMETRIA, TOCCO e GESTO.

    ─────────────────────────────────────────────────────────────────────────
    LA LEGGE (non sono numeri scelti a occhio: sono stati misurati)

    1. N elementi x 44px di bersaglio non stanno in 360px: e' aritmetica.
       Quindi oltre una soglia si apre una SECONDA FILA (e una terza, se
       serve). Il passo verticale fra le file non e' un numero a caso: vale
       STRISCIA IDENTIFICATIVA + SOLLEVAMENTO, cosi' la fila di sotto, anche
       tutta sollevata, si ferma sempre sotto l'ultimo pixel della striscia
       della fila di sopra. E' questo vincolo a decidere quanto puo' essere
       grande l'elemento, non il contrario.

    2. LA LARGHEZZA SI USA TUTTA. Il passo orizzontale e' quello che riempie
       la riga, non un numero fisso. Quando avanza spazio e le file sono
       piene, allargare e basta lascerebbe canali di sfondo: allora la fila
       di sotto si SFALSA DI MEZZO PASSO e ogni suo elemento va nel buco di
       quelli di sopra (mezzo passo di sfalsamento costa mezzo passo di
       larghezza: ecco il k-0,5). Con una fila sola nessuno chiude i buchi,
       e li' resta il tetto `sparso`: pochi elementi respirano.

    3. IL BERSAGLIO NON E' L'ELEMENTO, ed e' fatto in due mani. Sopra il
       ventaglio c'e' uno strato di celle:
       a) LA SPARTIZIONE si divide TUTTA l'area, una cella per elemento, mai
          piu' piccola di `passoMin` x `tapMin`, mai sovrapposta a un'altra.
          Comanda dove l'elemento non si vede (l'aria sopra il ventaglio).
       b) LE FACCE, sopra la spartizione e nello stesso ordine della pila:
          un SOSIA per elemento, che ne replica rettangolo, rotazione, quota
          (sollevamento compreso) e raggio d'angolo, rifatto a ogni disegno.
          E' cosi' che il SECONDO tocco — quello che deseleziona — colpisce
          l'elemento giusto: il tocco e' per costruzione identico alla vista.

    4. L'ALTEZZA VUOL DIRE UNA COSA SOLA: "questo l'ho scelto". Il
       sollevamento e' ESCLUSIVO: si muove solo l'elemento toccato, nessun
       vicino cede il posto. Il posto per salire e' gia' nel passo fra le
       file (legge 1) e nell'aria sopra la fila alta.

    5. ARCO: rotazione progressiva, offset verticale a parabola, e un jitter
       DETERMINISTICO (stesso elemento -> stesso disordine, sempre) perche'
       niente sia allineato a griglia perfetta. Nessun rumore in verticale:
       li' un pixel di rumore e' un pixel di dubbio su chi e' scelto.

    ─────────────────────────────────────────────────────────────────────────
    USO MINIMO

      var v = Ventaglio.crea('#mano', {
        elementi: carte,
        disegna:  function (d, i) { var e = document.createElement('div');
                                    e.textContent = d.nome; return e; },
        chiave:   function (d) { return d.id; },
        scelti:   function (d) { return d.scelta; },
        onTocco:  function (d) { d.scelta = !d.scelta; },
        onSposta: function (d, da, a) { Ventaglio.sposta(carte, da, a); }
      });
      v.aggiorna(carte);

    Le opzioni sono tutte in DEF, qui sotto, con i valori predefiniti.
    Vedi ventaglio.md.
*/
(function (global) {
  'use strict';

  var DEF = {
    /* ---- dati e disegno: li fornisce il gioco ---- */
    elementi:   [],     // array di dati qualsiasi
    disegna:    null,   // (dato, i) -> HTMLElement   [obbligatoria]
    chiave:     null,   // (dato, i) -> id stabile    (default: dato.id, poi i)
    scelti:     null,   // (dato, i) -> bool
    sincronizza:null,   // (el, dato, i, info) — richiamata a ogni disegno
    onTocco:    null,   // (dato, i)
    onSposta:   null,   // (dato, da, a) — riordino per trascinamento

    /* ---- geometria (le misure che dipendono dal gioco) ---- */
    altezza:      200,    // budget verticale in px; 0 = usa l'altezza del contenitore
    rapporto:     0.69,   // larghezza / altezza dell'elemento
    larghezzaMax: 90,     // un elemento non diventa mai un poster
    larghezzaMin: 42,
    striscia:     0.8125, // altezza della striscia identificativa, in LARGHEZZE
                          // di elemento (e' cio' che non va mai coperto)
    strisciaPx:   0,      // se > 0 vince su `striscia`: striscia in px assoluti
    salto:        0.30,   // sollevamento in selezione: 30% dell'altezza
    cupola:       0.09,   // ampiezza della parabola del ventaglio
    rotazione:    11,     // gradi al bordo dell'arco
    padX:         9,      // aria ai lati
    padTop:       2,      // margine in cima: un elemento ruotato sporge
    banda:        0,      // riga riservata sotto il ventaglio (contatore)
    passoMin:     45,     // larghezza minima della striscia toccabile
    tapMin:       44,     // il minimo tattile: non si negozia
    maxPerFila:   0,      // 0 = automatico (quanti ce ne stanno a passoMin)
    sparso:       0.92,   // con una fila sola gli elementi non si staccano mai del tutto
    margine:      1.5,    // aria fra l'elemento piu' esterno e il bordo
    eps:          3,      // margine per rotazione e arrotondamenti
    disordine:    1,      // 0 = griglia perfetta, 1 = jitter dei riferimenti

    /* Da che parte si vede l'elemento coperto. 'sinistra' (predefinito): ogni
       elemento sta sopra il vicino di sinistra, e resta scoperta la striscia
       SINISTRA. 'destra': l'ordine di impilamento dentro la fila si rovescia
       e resta scoperta la striscia DESTRA — serve quando l'informazione che
       identifica l'elemento e' stampata a destra (il costo di una carta di
       Magic sta in alto a destra). Incrociato con `striscia`, che garantisce
       la fascia alta contro la fila di sotto, e' l'ANGOLO in alto a destra a
       essere garantito. */
    scoperto:     'sinistra',

    /* ---- gesto ---- */
    riordino:     true,   // trascinamento per riordinare (serve onSposta)
    soglia:       9,      // px oltre i quali un tocco diventa trascinamento

    /* ESTRAZIONE: il trascinamento tira l'elemento FUORI dal ventaglio invece
       di riordinarlo, e chi lo riceve e' il gioco, che decide cosa farne in
       base al punto in cui il dito ha lasciato. Serve a "gioca la carta
       portandola sul tavolo". Esclude il riordino: il dito e' uno solo, e un
       trascinamento non puo' voler dire due cose.
         onEstrai(dato, i, {x, y, sotto})  -> true se l'elemento e' stato
         consumato (sparisce), false/undefined se deve tornare al suo posto.
       `sotto` e' l'elemento del documento sotto il dito al rilascio.
       onSopra(dato, {x, y, sotto}) viene chiamata MENTRE si trascina, a ogni
       cambio di bersaglio, per accendere la zona di rilascio. */
    estrai:       false,
    onEstrai:     null,
    onSopra:      null,

    /* PRESSIONE LUNGA: il dito fermo su un elemento per `attesaLunga` ms.
       Annulla il tocco e il trascinamento — o aprendo il menu ti ritroveresti
       anche la carta giocata. */
    onLungo:      null,
    attesaLunga:  420,

    /* ---- contorno ---- */
    raggio:       '',     // raggio d'angolo dei sosia; '' = letto dall'elemento
    contatore:    false,  // true, oppure (n, scelti) -> HTML
    testoRiordino:'↔  spostalo dove vuoi',
    debug:        false   // disegna i riquadri dei bersagli
  };

  function assegna(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  /* Sposta un elemento dentro un array: `a` e' l'indice di destinazione
     calcolato DOPO aver tolto l'elemento (e' quello che riceve onSposta). */
  function sposta(arr, da, a) {
    if (da === a || da < 0 || da >= arr.length) return arr;
    var x = arr.splice(da, 1)[0];
    arr.splice(a, 0, x);
    return arr;
  }

  function crea(contenitore, opzioni) {
    var box = typeof contenitore === 'string'
      ? document.querySelector(contenitore) : contenitore;
    if (!box) throw new Error('Ventaglio: contenitore non trovato');

    var opz = assegna(assegna({}, DEF), opzioni || {});
    if (typeof opz.disegna !== 'function') {
      throw new Error('Ventaglio: serve una funzione `disegna(dato, i)`');
    }
    if (opz.contatore && !opz.banda) opz.banda = 14;

    // --- stato dell'istanza ---
    var strato = null, caret = null, conta = null;
    var elementi = {};      // chiave -> HTMLElement (riusati fra un disegno e l'altro)
    var posMap = {};        // chiave -> posizione corrente
    var geo = null;
    var ordine = [];        // [{chiave, dato, i}] nell'ordine corrente
    var trascino = null;
    var raggio = opz.raggio || '8px';
    var vivo = true, pronto = false;
    var ultimaL = -1, ultimaH = -1;

    /* rumore deterministico: gli elementi non sono mai allineati a griglia, ma
       il disordine di un elemento non cambia mai fra un disegno e l'altro. */
    function rnd(chiave) {
      var h = 2166136261, i;
      for (i = 0; i < chiave.length; i++) {
        h ^= chiave.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return ((h >>> 0) % 100000) / 100000;
    }

    // ------------------------------------------------------------- geometria
    function geometria(n, L, H) {
      var util = Math.max(40, L - opz.padX * 2);
      var maxFila = opz.maxPerFila > 0
        ? opz.maxPerFila
        : Math.max(1, Math.floor(util / opz.passoMin));
      var righe = Math.max(1, Math.ceil(n / maxFila));
      var disp = H - opz.banda - opz.padTop;
      var fissa = opz.strisciaPx > 0;

      /* Il budget verticale, dall'alto in basso:
           cupola + salto      aria sopra la fila alta, perche' un elemento
                               scelto lassu' possa saltare senza uscire
           (righe-1) x passoV  ogni passo vale striscia + salto (legge 1)
           h                   l'ultima fila, intera
         Risolto in h: e' l'altezza piu' grande che rispetta tutto. */
      var den = 1 + opz.cupola + opz.salto +
                (righe - 1) * ((fissa ? 0 : opz.striscia * opz.rapporto) + opz.salto);
      var num = disp - (righe - 1) * (opz.eps + (fissa ? opz.strisciaPx : 0));
      var hMax = num / den;

      var k = Math.max(1, Math.ceil(n / righe));
      /* Le prime righe-1 file sono sempre piene: lo sfalsamento conviene
         quando ce ne sono almeno due da incastrare fra loro, cioe' o tutte le
         file sono piene, o le file sono almeno tre. */
      var pieno = (n === k * righe) || righe >= 3;

      var w = Math.min(opz.larghezzaMax, hMax * opz.rapporto);
      if (!(w > 0)) w = opz.larghezzaMin;

      var passo = 0, sfalsa = 0;
      if (k > 1) {
        passo = (util - w) / (k - 1);          // prima regola: la larghezza si usa tutta
        if (righe === 1) {
          /* Una fila sola non ha nessuno sotto che le chiuda i buchi: oltre
             `sparso` gli elementi si staccherebbero e basta. Li' il tetto resta. */
          passo = Math.min(opz.sparso * w, passo);
        } else if (pieno && passo > opz.sparso * w) {
          /* File piene e larghezza che avanza: si allarga E si sfalsa la fila
             pari di mezzo passo, cosi' ogni elemento di sotto sta nel buco di
             quelli di sopra e l'unione delle file copre la riga senza
             interruzioni. Mezzo passo costa mezzo passo: ecco il k-0,5. */
          passo = (util - w) / (k - 0.5);
          sfalsa = passo / 2;
        }
        if (passo < opz.passoMin) {            // la striscia toccabile non si negozia:
          passo = opz.passoMin;                // si rimpicciolisce l'elemento, non il dito
          sfalsa = 0;
          w = Math.max(opz.larghezzaMin, util - passo * (k - 1));
        }
      }
      w = Math.round(w * 10) / 10;
      passo = Math.round(passo * 10) / 10;
      sfalsa = Math.round(sfalsa * 10) / 10;

      var h = w / opz.rapporto;
      var salto = h * opz.salto, cupola = h * opz.cupola;
      // ricavato dalla larghezza VERA: se w e' stato ridotto sopra (bersaglio
      // minimo) il passo fra le file si stringe di conseguenza e resta esatto
      var passoV = (fissa ? opz.strisciaPx : opz.striscia * w) + salto + opz.eps;

      var conteggi = [], resto = n, r;
      for (r = 0; r < righe; r++) {
        var c = Math.min(k, resto);
        conteggi.push(c);
        resto -= c;
      }

      /* Il ventaglio e' ancorato in basso: se avanza spazio (mano corta,
         elementi grandi) l'aria finisce sopra, dove serve al sollevamento,
         non sotto, dove farebbe galleggiare la mano nel vuoto. */
      var blocco = (righe - 1) * passoV + h;
      var base = Math.max(opz.padTop + salto + cupola, H - opz.banda - blocco);

      /* Se avanza aria la spendo aprendo di piu' l'arco. Con due file non
         avanza niente e l'arco non si tocca: allargarlo li' mangerebbe il
         passo fra le file, cioe' proprio la striscia identificativa. */
      var extra = base - (opz.padTop + salto + cupola);
      if (extra > 0 && righe === 1) cupola += Math.min(extra * 0.55, h * 0.09);

      /* Ogni fila e' centrata per conto proprio: quando la fila di sotto ha un
         elemento in meno si trova gia' sfalsata di mezzo passo, ed e' proprio
         quello che serve. Quando invece lo sfalsamento e' stato pagato (sopra),
         le file pari e dispari si scostano di mezzo passo in versi opposti:
         ognuna lascia scoperto mezzo passo a un capo, e ci sta l'altra. */
      var top = [], x0 = [];
      for (r = 0; r < righe; r++) {
        top.push(base + r * passoV);
        var span = w + (conteggi[r] - 1) * passo;
        var cx = (L - span) / 2;
        x0.push(cx + (sfalsa ? (r % 2 ? 0.5 : -0.5) * sfalsa : 0));
      }

      /* Le bande di tocco. Il confine fra due file sta a meta' strada fra il
         centro piu' basso della fila sopra e il centro piu' alto (cioe'
         sollevato) della fila sotto: cosi' il centro di ogni elemento cade
         sempre nella propria banda, anche quando e' selezionato e salta su. */
      var bande = [0];
      for (r = 1; r < righe; r++) {
        bande.push(top[r - 1] + h / 2 + (passoV - cupola - salto) / 2);
      }
      bande.push(H - opz.banda);

      return {
        n: n, righe: righe, conteggi: conteggi, k: k, sfalsa: sfalsa,
        w: w, h: h, passo: passo, passoV: passoV,
        salto: salto, cupola: cupola,
        top: top, x0: x0, bande: bande,
        larghezza: L, altezza: H, util: util
      };
    }

    /* Un elemento ruotato occupa piu' della propria larghezza, e quello scelto
       si porta dietro il contorno di selezione: il piu' esterno deve rientrare
       tenendo conto di entrambi SEMPRE — anche da non scelto, altrimenti
       scivolerebbe di lato nel momento in cui lo scegli. */
    function sporgenza(rot, g) {
      var a = Math.abs(rot) * Math.PI / 180;
      var anello = Math.min(3.5, Math.max(2, g.w * 0.055));
      return (g.w * Math.cos(a) + g.h * Math.sin(a) - g.w) / 2 + anello + opz.margine;
    }

    // posizioni per un dato ordine (serve anche all'anteprima del riordino)
    function posizioni(lista, g) {
      var out = [], idx = 0, r, c;
      for (r = 0; r < g.righe; r++) {
        for (c = 0; c < g.conteggi[r]; c++) {
          var it = lista[idx];
          if (!it) break;
          var left = g.x0[r] + c * g.passo;
          var t = (left + g.w / 2 - g.larghezza / 2) / (g.util / 2);
          if (t > 1) t = 1; else if (t < -1) t = -1;
          var rot = opz.rotazione * t +
                    (rnd(it.chiave + '#') - 0.5) * 2.6 * opz.disordine;
          var sp = sporgenza(rot, g);
          left += (rnd(it.chiave) - 0.5) * 1.8 * opz.disordine;
          left = Math.max(sp, Math.min(g.larghezza - g.w - sp, left));
          /* Niente disordine in verticale: la quota e' l'unica cosa che deve
             restare leggibile a colpo d'occhio (chi e' scelto e chi no). */
          out.push({
            chiave: it.chiave, dato: it.dato, i: idx, r: r, c: c, su: 0,
            left: left,
            top:  g.top[r] - g.cupola * (1 - t * t),
            rot:  rot
          });
          idx++;
        }
      }
      return out;
    }

    /* Quanto e' alzato ogni elemento rispetto al proprio posto nel ventaglio.
       Un contributo solo, e nessuna eccezione: il salto di chi e' scelto. Chi
       non e' scelto non si muove di un pixel — mai, nemmeno per far posto. */
    function assetto(pos) {
      pos.forEach(function (p) {
        p.scelto = !!(opz.scelti && opz.scelti(p.dato, p.i));
        p.su = p.scelto ? Math.max(-geo.salto, 0 - p.top) : 0;
      });
    }

    // ------------------------------------------------------------- trasformi
    /* La risposta al dito, prima ancora di sapere cosa succedera': l'elemento
       si muove verso lo stato in cui sta per finire. Non scelto -> accenna a
       salire; gia' scelto -> si riabbassa, perche' toccarlo lo deseleziona. */
    function trasforma(p, e, extraY, scala, extraRot) {
      var su = p.su || 0;
      if (e && e.classList.contains('is-premuto')) {
        su += geo.salto * (p.scelto ? 0.22 : -0.42);
      }
      if (su < 0 - p.top) su = 0 - p.top;          // niente sfonda il soffitto
      return 'translate(' + p.left.toFixed(2) + 'px,' +
             (p.top + su + (extraY || 0)).toFixed(2) + 'px)' +
             ' rotate(' + (p.rot + (extraRot || 0)).toFixed(2) + 'deg)' +
             (scala ? ' scale(' + scala + ')' : '');
    }

    function riapplica(chiave) {
      var e = elementi[chiave], p = posMap[chiave];
      if (e && p && !(trascino && trascino.attivo && trascino.chiave === chiave)) {
        e.style.transform = trasforma(p, e);
        e.style.zIndex = zeta(p);
      }
    }

    /* L'ordine di sovrapposizione non cambia MAI con la selezione: dentro una
       fila ogni elemento sta sopra il vicino da un lato solo (quale lato lo
       dice `scoperto`), e la fila di sotto sta sopra quella di sopra. Se un
       elemento scelto salisse anche in pila, coprirebbe la striscia
       identificativa del vicino. */
    function colonna(p) {
      if (opz.scoperto !== 'destra') return p.c;
      // rovesciata: il primo della fila sta sopra tutti, cosi' di ognuno
      // resta scoperta la striscia di DESTRA
      var n = (geo && geo.conteggi[p.r]) || 1;
      return n - 1 - p.c;
    }
    function zeta(p) {
      return String(10 + p.r * 100 + colonna(p));
    }

    // ------------------------------------------------------------- struttura
    function prepara() {
      if (pronto) return;
      pronto = true;
      box.classList.add('ventaglio');
      if (opz.debug) box.classList.add('is-debug');

      caret = document.createElement('div');
      caret.className = 'ventaglio__caret';
      box.appendChild(caret);

      strato = document.createElement('div');
      strato.className = 'ventaglio__tocchi';
      box.appendChild(strato);

      if (opz.contatore) {
        conta = document.createElement('div');
        conta.className = 'ventaglio__conta';
        box.appendChild(conta);
      }

      strato.addEventListener('pointerdown', giu);
      strato.addEventListener('pointermove', muovi);
      strato.addEventListener('pointerup', sollevato);
      strato.addEventListener('pointercancel', sollevato);
      strato.addEventListener('contextmenu', noMenu);
      // rete di sicurezza: se la cattura del puntatore non funziona, il dito
      // non puo' comunque restare incollato a un elemento
      global.addEventListener('pointerup', sollevato);
      global.addEventListener('pointercancel', sollevato);
    }

    function noMenu(ev) { ev.preventDefault(); }

    // --------------------------------------------------------------- disegno
    function misure() {
      var L = box.clientWidth || 360;
      var H = opz.altezza > 0 ? opz.altezza : (box.clientHeight || 200);
      if (opz.altezza > 0) box.style.height = opz.altezza + 'px';
      return { L: L, H: H };
    }

    function chiaveDi(d, i) {
      var k = opz.chiave ? opz.chiave(d, i) : (d && d.id != null ? d.id : i);
      return String(k);
    }

    function disegnaTutto() {
      if (!vivo) return;
      prepara();
      var lista = opz.elementi || [];
      var m = misure();
      ultimaL = m.L; ultimaH = m.H;
      geo = geometria(lista.length, m.L, m.H);
      box.style.setProperty('--ventaglio-h', m.H + 'px');
      box.style.setProperty('--ventaglio-w', geo.w + 'px');

      var visti = {}, vivi = {}, nuovi = [], scelti = 0;
      ordine = [];
      lista.forEach(function (dato, i) {
        var k = chiaveDi(dato, i);
        while (visti[k]) k += '~';              // chiavi doppie: mai fondere due elementi
        visti[k] = true; vivi[k] = true;
        ordine.push({ chiave: k, dato: dato, i: i });

        var e = elementi[k];
        if (!e) {
          e = opz.disegna(dato, i);
          if (!e || e.nodeType !== 1) {
            var f = document.createElement('div');
            f.textContent = String(e == null ? '' : e);
            e = f;
          }
          e.classList.add('ventaglio__el');
          e.setAttribute('data-chiave', k);
          /* Queste sei non sono decorazione, sono la geometria: vanno messe
             in linea, perche' un foglio di stile del gioco che dichiarasse
             `position: relative` sull'elemento manderebbe il ventaglio in
             colonna. Lo stile in linea vince su qualunque regola d'autore. */
          e.style.position = 'absolute';
          e.style.left = '0';
          e.style.top = '0';
          e.style.boxSizing = 'border-box';
          e.style.transformOrigin = '50% 50%';
          e.style.pointerEvents = 'none';
          box.insertBefore(e, caret);
          elementi[k] = e;
          nuovi.push(e);
        }
        var sc = !!(opz.scelti && opz.scelti(dato, i));
        if (sc) scelti++;
        e.classList.toggle('is-scelto', sc);
        e.style.width = geo.w.toFixed(2) + 'px';
        e.style.height = geo.h.toFixed(2) + 'px';
        e.style.setProperty('--v-w', geo.w.toFixed(2) + 'px');
        e.style.setProperty('--v-h', geo.h.toFixed(2) + 'px');
        if (opz.sincronizza) {
          opz.sincronizza(e, dato, i, { scelto: sc, w: geo.w, h: geo.h, geo: geo });
        }
      });
      Object.keys(elementi).forEach(function (k) { if (!vivi[k]) congeda(k); });

      if (!opz.raggio && ordine.length) {
        var uno = elementi[ordine[0].chiave];
        if (uno) raggio = getComputedStyle(uno).borderTopLeftRadius || raggio;
      }

      var pos = posizioni(ordine, geo);
      assetto(pos);
      posMap = {};
      pos.forEach(function (p) {
        posMap[p.chiave] = p;
        var e = elementi[p.chiave];
        if (!e) return;
        e.style.zIndex = zeta(p);
        var finale = trasforma(p, e);
        if (nuovi.indexOf(e) !== -1) {
          // atterra: arriva da sotto, non compare
          e.style.transition = 'none';
          e.style.opacity = '0';
          e.style.transform = trasforma(p, e, 70, 0.86, -p.rot * 0.7);
          e.setAttribute('data-finale', finale);
          void e.offsetWidth;
        } else {
          e.style.transform = finale;
        }
      });
      if (nuovi.length) atterra(nuovi);

      bersagli(pos);
      aggiornaConta(lista.length, scelti);
    }

    /* Gli elementi atterrano uno dopo l'altro, ma si accendono TUTTI INSIEME:
       a scaglionare la luce, con quattordici elementi, gli ultimi restano
       mezzi trasparenti per mezzo secondo. Il ritardo va solo al transform
       (primo valore della transition), mai all'opacity (secondo). */
    function atterra(nuovi) {
      var passo = Math.min(24, 170 / Math.max(1, nuovi.length));
      requestAnimationFrame(function () {
        nuovi.forEach(function (e, i) {
          var d = Math.round(i * passo);
          e.style.transition = '';
          e.classList.add('is-atterra');
          e.style.transitionDelay = d + 'ms, 0ms';
          e.style.opacity = '1';
          /* La posizione si rilegge ADESSO da posMap, non si usa quella
             catturata quando l'elemento e' nato: fra la chiamata e questo
             fotogramma ci puo' essere stato un altro disegno. Chi pesca N
             elementi uno per volta fa N disegni nello stesso tic, e ogni
             disegno stringe il ventaglio: con `data-finale` i primi arrivati
             restavano parcheggiati dove sarebbero andati in una mano piu'
             corta — addosso al vicino, che spariva del tutto. L'attributo
             resta solo come rete di sicurezza. */
          var p = posMap[e.getAttribute('data-chiave')];
          e.style.transform = p ? trasforma(p, e) : (e.getAttribute('data-finale') || '');
          setTimeout(function () {
            e.classList.remove('is-atterra');
            e.style.transitionDelay = '';
          }, 520 + d);
        });
      });
    }

    function congeda(chiave) {
      var e = elementi[chiave];
      delete elementi[chiave];
      delete posMap[chiave];
      if (!e) return;
      e.classList.remove('is-premuto', 'is-trascinato');
      e.classList.add('is-via');
      e.style.transform = (e.style.transform || '') + ' translateY(-48px) scale(.9)';
      setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 260);
    }

    /* Lo strato dei bersagli, rifatto a ogni disegno perche' deve seguire gli
       elementi quando saltano su. Prima la spartizione (che copre tutta l'area
       e tiene il minimo tattile anche dove non c'e' niente da vedere), poi le
       facce, nell'ordine della pila. */
    function bersagli(pos) {
      strato.innerHTML = '';
      var file = [];
      pos.forEach(function (p) { (file[p.r] || (file[p.r] = [])).push(p); });

      file.forEach(function (fila, r) {
        var y = geo.bande[r], alt = geo.bande[r + 1] - geo.bande[r];
        fila.forEach(function (p, c) {
          var x  = c === 0 ? 0 : geo.x0[r] + c * geo.passo;
          var x2 = c === fila.length - 1 ? geo.larghezza : geo.x0[r] + (c + 1) * geo.passo;
          cella(p.chiave, x, y, x2 - x, alt);
        });
      });

      /* I sosia si impilano nell'ORDINE DELLA PILA, non in quello dei dati:
         cosi' il risultato del tocco e' per costruzione cio' che si vede.
         Con `scoperto: 'destra'` la pila dentro la fila e' rovesciata, e va
         rovesciata anche qui — altrimenti si tocca l'elemento nascosto. */
      file.forEach(function (fila) {
        var f = opz.scoperto === 'destra' ? fila.slice().reverse() : fila;
        f.forEach(faccia);
      });
    }

    /* Il sosia: stessa larghezza, stessa altezza, stessa rotazione, stessa
       quota — salto compreso — e stesso raggio d'angolo. */
    function faccia(p) {
      var d = document.createElement('div');
      /* niente classe `tap` sui sosia: il minimo tattile lo garantisce la
         spartizione, che sta sotto. Un sosia puo' essere piu' stretto di 44px
         (elemento piccolo, mano lunga) senza che il bersaglio lo sia. */
      d.className = 'ventaglio__tocco ventaglio__tocco--faccia';
      d.setAttribute('data-chiave', p.chiave);
      d.setAttribute('aria-hidden', 'true');
      d.style.width = geo.w.toFixed(2) + 'px';
      d.style.height = geo.h.toFixed(2) + 'px';
      d.style.borderRadius = raggio;
      d.style.transform =
        'translate(' + p.left.toFixed(2) + 'px,' + (p.top + p.su).toFixed(2) + 'px)' +
        ' rotate(' + p.rot.toFixed(2) + 'deg)';
      strato.appendChild(d);
    }

    function cella(chiave, x, y, w, h) {
      var d = document.createElement('div');
      d.className = 'ventaglio__tocco tap';
      d.setAttribute('data-chiave', chiave);
      d.setAttribute('aria-hidden', 'true');
      d.style.left = x.toFixed(2) + 'px';
      d.style.top = y.toFixed(2) + 'px';
      d.style.width = Math.max(opz.passoMin, w).toFixed(2) + 'px';
      d.style.height = Math.max(opz.tapMin, h).toFixed(2) + 'px';
      strato.appendChild(d);
    }

    function aggiornaConta(n, sel) {
      if (!conta) return;
      if (trascino && trascino.attivo) {
        conta.className = 'ventaglio__conta is-riordino';
        conta.textContent = opz.testoRiordino;
        return;
      }
      conta.className = 'ventaglio__conta';
      if (typeof opz.contatore === 'function') {
        conta.innerHTML = opz.contatore(n, sel);
        return;
      }
      conta.innerHTML = '<b>' + n + '</b>' +
        (sel ? ' <i>· ' + sel + '</i>' : '');
    }

    // ----------------------------------------------------------------- gesto
    function giu(ev) {
      var cel = ev.target.closest && ev.target.closest('.ventaglio__tocco');
      if (!cel) return;
      var chiave = cel.getAttribute('data-chiave');
      var e = elementi[chiave], p = posMap[chiave];
      if (!e || !p) return;
      ev.preventDefault();
      try { strato.setPointerCapture(ev.pointerId); } catch (x) {}
      var rb = box.getBoundingClientRect();
      var da = -1, j;
      for (j = 0; j < ordine.length; j++) if (ordine[j].chiave === chiave) da = j;
      trascino = {
        chiave: chiave, dato: p.dato, da: da, pid: ev.pointerId,
        x0: ev.clientX, y0: ev.clientY,
        gx: ev.clientX - rb.left - (p.left + geo.w / 2),
        gy: ev.clientY - rb.top - (p.top + geo.h / 2),
        attivo: false, annullato: false, indice: -1,
        lungo: false, timer: null, sotto: null
      };
      e.classList.add('is-premuto');
      riapplica(chiave);
      if (typeof opz.onLungo === 'function') {
        trascino.timer = global.setTimeout(function () {
          if (!trascino || trascino.chiave !== chiave || trascino.attivo) return;
          /* Il dito e' rimasto fermo: e' una pressione lunga. Da qui in poi
             questo tocco non e' piu' ne' un tocco ne' un trascinamento —
             altrimenti alzando il dito si aprirebbe il menu E si giocherebbe
             la carta. */
          trascino.lungo = true;
          trascino.annullato = true;
          var el = elementi[chiave];
          if (el) { el.classList.remove('is-premuto'); riapplica(chiave); }
          opz.onLungo(p.dato, p.i);
        }, opz.attesaLunga);
      }
    }

    function fermaTimer() {
      if (trascino && trascino.timer) { global.clearTimeout(trascino.timer); trascino.timer = null; }
    }

    /* Chi c'e' sotto il dito, fuori dal ventaglio: lo strato dei bersagli
       copre tutta la mano, quindi va spento per un istante o si vedrebbe
       sempre e solo lui. */
    function sottoIlDito(x, y) {
      var vecchio = strato.style.pointerEvents;
      strato.style.pointerEvents = 'none';
      var el = global.document.elementFromPoint(x, y);
      strato.style.pointerEvents = vecchio;
      return el;
    }

    function estrazioneAttiva() {
      return opz.estrai && typeof opz.onEstrai === 'function';
    }

    function muovi(ev) {
      if (!trascino || ev.pointerId !== trascino.pid) return;
      if (trascino.lungo) return;                 // il menu ha preso il tocco
      var dx = ev.clientX - trascino.x0, dy = ev.clientY - trascino.y0;
      if (!trascino.attivo) {
        if (Math.abs(dx) + Math.abs(dy) < opz.soglia) return;
        fermaTimer();                             // si e' mosso: non e' una pressione lunga
        if (!estrazioneAttiva() && (!opz.riordino || typeof opz.onSposta !== 'function')) {
          // niente riordino: il dito che scivola annulla il tocco, non lo conferma
          if (!trascino.annullato) {
            trascino.annullato = true;
            var el = elementi[trascino.chiave];
            if (el) { el.classList.remove('is-premuto'); riapplica(trascino.chiave); }
          }
          return;
        }
        avvia();
      }
      ev.preventDefault();
      var rb = box.getBoundingClientRect();
      var px = ev.clientX - rb.left, py = ev.clientY - rb.top;
      var e = elementi[trascino.chiave];
      if (!e) return;
      e.style.transform =
        'translate(' + (px - trascino.gx - geo.w / 2).toFixed(1) + 'px,' +
                       (py - trascino.gy - geo.h / 2).toFixed(1) + 'px)' +
        ' rotate(' + Math.max(-11, Math.min(11, dx * 0.09)).toFixed(2) + 'deg) scale(1.07)';

      if (estrazioneAttiva()) {
        // l'elemento segue il dito e basta: chi decide dove puo' finire e'
        // il gioco, che qui riceve solo cosa c'e' sotto
        var sotto = sottoIlDito(ev.clientX, ev.clientY);
        if (sotto !== trascino.sotto) {
          trascino.sotto = sotto;
          if (typeof opz.onSopra === 'function') {
            opz.onSopra(trascino.dato, { x: ev.clientX, y: ev.clientY, sotto: sotto });
          }
        }
        return;
      }

      // il posto lo decide il BORDO SINISTRO dell'elemento sotto il dito, non
      // il dito: altrimenti si sbaglia sistematicamente di una posizione
      var idx = indiceDaPunto(px - trascino.gx - geo.w / 2, py - trascino.gy);
      if (idx !== trascino.indice) {
        trascino.indice = idx;
        anteprima(idx);
      }
    }

    function avvia() {
      trascino.attivo = true;
      var e = elementi[trascino.chiave];
      if (e) {
        e.classList.add('is-trascinato');
        e.style.zIndex = '900';
      }
      /* In estrazione l'elemento deve poter uscire DAL ventaglio e stare
         sopra tutto il resto della pagina: il contenitore della mano ha un
         contesto di impilamento proprio, e senza toglierlo la carta
         trascinata scomparirebbe sotto il campo di gioco. */
      if (estrazioneAttiva()) box.classList.add('is-estrazione');
      else box.classList.add('is-riordino');
      aggiornaConta(ordine.length, 0);
    }

    function indiceDaPunto(px, py) {
      var r = 0, i;
      for (i = 0; i < geo.righe; i++) if (py >= geo.bande[i]) r = i;
      var base = 0;
      for (i = 0; i < r; i++) base += geo.conteggi[i];
      var c = Math.round((px - geo.x0[r]) / (geo.passo || geo.w));
      if (c < 0) c = 0;
      if (c > geo.conteggi[r] - 1) c = geo.conteggi[r] - 1;
      var idx = base + c;
      if (idx < 0) idx = 0;
      if (idx > geo.n - 1) idx = geo.n - 1;
      return idx;
    }

    /* Anteprima del riordino: gli altri si spostano davvero per far posto, e
       un segno dice dove finira'. Il feedback e' MENTRE trascini. */
    function anteprima(idx) {
      var it = null, senza = [];
      ordine.forEach(function (o) {
        if (o.chiave === trascino.chiave) it = o; else senza.push(o);
      });
      if (!it) return;
      var ord = senza.slice(0, idx).concat([it], senza.slice(idx));
      var pos = posizioni(ord, geo);
      assetto(pos);
      posMap = {};
      pos.forEach(function (p) {
        posMap[p.chiave] = p;
        if (p.chiave === trascino.chiave) { segna(p); return; }
        var e = elementi[p.chiave];
        if (!e) return;
        e.style.zIndex = zeta(p);
        e.style.transform = trasforma(p, e);
      });
    }

    function segna(p) {
      caret.classList.add('is-viva');
      caret.style.left = (p.left - 4).toFixed(1) + 'px';
      caret.style.top = (p.top + geo.h * 0.06).toFixed(1) + 'px';
      caret.style.height = (geo.h * 0.88).toFixed(1) + 'px';
    }

    function sollevato(ev) {
      if (!trascino || ev.pointerId !== trascino.pid) return;
      fermaTimer();
      var t = trascino;
      trascino = null;
      var e = elementi[t.chiave];
      if (e) e.classList.remove('is-premuto', 'is-trascinato');
      if (caret) caret.classList.remove('is-viva');
      box.classList.remove('is-riordino', 'is-estrazione');
      try { strato.releasePointerCapture(t.pid); } catch (x) {}
      if (typeof opz.onSopra === 'function' && t.sotto) opz.onSopra(null, null);

      var out = null;
      if (t.lungo) {
        // la pressione lunga ha gia' fatto la sua parte: qui non succede altro
      } else if (t.attivo && estrazioneAttiva()) {
        /* Il gioco decide: se dice di si' l'elemento e' stato consumato e
           sparisce col ridisegno; se dice di no torna al suo posto — e ci
           torna comunque, perche' `disegnaTutto` rimette tutti in riga. */
        out = opz.onEstrai(t.dato, t.da, {
          x: ev.clientX, y: ev.clientY, sotto: sottoIlDito(ev.clientX, ev.clientY),
        });
      } else if (t.attivo) {
        var a = t.indice < 0 ? 0 : t.indice;
        if (a !== t.da && typeof opz.onSposta === 'function') {
          out = opz.onSposta(t.dato, t.da, a);
        }
      } else if (!t.annullato && typeof opz.onTocco === 'function') {
        out = opz.onTocco(t.dato, t.da);
      }
      if (Array.isArray(out)) opz.elementi = out;
      disegnaTutto();
    }

    // -------------------------------------------------------------- ridisegno
    function forse() {
      if (!vivo || !pronto) return;
      var m = misure();
      if (m.L === ultimaL && m.H === ultimaH) return;
      disegnaTutto();
    }
    var osservatore = null;
    if (global.ResizeObserver) {
      osservatore = new global.ResizeObserver(forse);
      osservatore.observe(box);
    }
    global.addEventListener('resize', forse);

    // ------------------------------------------------------------------- api
    var api = {
      aggiorna: function (nuovi) {
        if (nuovi) opz.elementi = nuovi;
        disegnaTutto();
        return api;
      },
      imposta: function (patch) {
        assegna(opz, patch || {});
        if (opz.contatore && !opz.banda) opz.banda = 14;
        if (pronto) {
          box.classList.toggle('is-debug', !!opz.debug);
          if (opz.contatore && !conta) {
            conta = document.createElement('div');
            conta.className = 'ventaglio__conta';
            box.appendChild(conta);
          }
        }
        ultimaL = -1;
        disegnaTutto();
        return api;
      },
      geometria: function () { return geo ? assegna({}, geo) : null; },
      elemento: function (chiave) { return elementi[String(chiave)] || null; },
      posizione: function (chiave) { return posMap[String(chiave)] || null; },
      contenitore: box,
      opzioni: opz,
      distruggi: function () {
        vivo = false;
        if (osservatore) osservatore.disconnect();
        global.removeEventListener('resize', forse);
        global.removeEventListener('pointerup', sollevato);
        global.removeEventListener('pointercancel', sollevato);
        if (strato) {
          strato.removeEventListener('pointerdown', giu);
          strato.removeEventListener('pointermove', muovi);
          strato.removeEventListener('pointerup', sollevato);
          strato.removeEventListener('pointercancel', sollevato);
          strato.removeEventListener('contextmenu', noMenu);
          strato.remove();
        }
        if (caret) caret.remove();
        if (conta) conta.remove();
        Object.keys(elementi).forEach(function (k) {
          if (elementi[k].parentNode) elementi[k].parentNode.removeChild(elementi[k]);
        });
        elementi = {}; posMap = {};
        box.style.height = '';
        box.style.removeProperty('--ventaglio-h');
        box.style.removeProperty('--ventaglio-w');
        box.classList.remove('ventaglio', 'is-debug', 'is-riordino');
      }
    };

    disegnaTutto();
    return api;
  }

  global.Ventaglio = { crea: crea, sposta: sposta, DEF: DEF, versione: '1.3' };
})(window);
