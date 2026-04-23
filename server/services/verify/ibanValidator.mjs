// server/services/verify/ibanValidator.mjs
// Validare IBAN mod-97 (offline) + decode bank code pentru România.
// Include TREZ (Trezoreria Statului) ca flag dedicat.

// Coduri trezorerie operative ANAF — 3 cifre din pozițiile 9-11 ale IBAN (după 'TREZ').
// Pattern: XX = județ, Y = unitate operativă locală (trezorerie municipală/orășenească/comunală).
// Sursa: Trezorerii.htm + IBAN-uri reale din iban_TREZXXX_TREZYYY.pdf (static.anaf.ro).
// Codurile marcate 'unverified' sunt estimate din pattern (județ corect + ordine alfabetică).
const TREZ_LOCALITY_CODES = {
  // Alba (00X)
  '001': { city: 'Alba Iulia',              county: 'Alba' },         // DGFP Alba
  '002': { city: 'Alba Iulia',              county: 'Alba' },         // AFPM
  '003': { city: 'Aiud',                    county: 'Alba' },         // unverified
  '004': { city: 'Blaj',                    county: 'Alba' },         // unverified
  '005': { city: 'Sebeș',                   county: 'Alba' },         // unverified
  '006': { city: 'Câmpeni',                 county: 'Alba' },         // IBAN real confirmat
  '007': { city: 'Ocna Mureș',              county: 'Alba' },         // IBAN real confirmat
  '008': { city: 'Abrud',                   county: 'Alba' },         // IBAN real confirmat
  '010': { city: 'Zlatna',                  county: 'Alba' },         // IBAN real confirmat
  '012': { city: 'Teiuș',                   county: 'Alba' },         // IBAN real confirmat
  '013': { city: 'Cugir',                   county: 'Alba' },         // unverified
  '014': { city: 'Câmpeni (AFPO)',           county: 'Alba' },         // IBAN real confirmat

  // Arad (02X)
  '021': { city: 'Arad',                    county: 'Arad' },         // DGFP Arad
  '026': { city: 'Nădlac',                  county: 'Arad' },         // IBAN real confirmat
  '027': { city: 'Pâncota',                 county: 'Arad' },         // IBAN real confirmat
  '028': { city: 'Sebiș',                   county: 'Arad' },         // IBAN real confirmat
  '029': { city: 'Gurahonț',                county: 'Arad' },         // IBAN real confirmat
  '031': { city: 'Pecica',                  county: 'Arad' },         // IBAN real confirmat
  '032': { city: 'Săvârșin',                county: 'Arad' },         // IBAN real confirmat
  '033': { city: 'Ineu',                    county: 'Arad' },         // unverified
  '034': { city: 'Lipova',                  county: 'Arad' },         // unverified
  '035': { city: 'Chișineu-Criș',           county: 'Arad' },         // unverified

  // Argeș (04X)
  '046': { city: 'Pitești',                 county: 'Argeș' },        // IBAN real confirmat
  '047': { city: 'Câmpulung Muscel',         county: 'Argeș' },        // unverified
  '048': { city: 'Curtea de Argeș',         county: 'Argeș' },        // unverified
  '049': { city: 'Mioveni',                 county: 'Argeș' },        // unverified
  '050': { city: 'Costești',                county: 'Argeș' },        // unverified
  '051': { city: 'Topoloveni',              county: 'Argeș' },        // unverified

  // Bacău (06X)
  '061': { city: 'Bacău',                   county: 'Bacău' },        // DGFP Bacău
  '062': { city: 'Onești',                  county: 'Bacău' },        // unverified
  '063': { city: 'Moinești',                county: 'Bacău' },        // unverified
  '064': { city: 'Buhuși',                  county: 'Bacău' },        // unverified
  '065': { city: 'Podu Turcului',           county: 'Bacău' },        // unverified

  // Bihor (08X)
  '081': { city: 'Oradea',                  county: 'Bihor' },        // DGFP Bihor
  '082': { city: 'Aleșd',                   county: 'Bihor' },        // unverified
  '083': { city: 'Beiuș',                   county: 'Bihor' },        // unverified
  '084': { city: 'Marghita',                county: 'Bihor' },        // unverified
  '085': { city: 'Salonta',                 county: 'Bihor' },        // unverified

  // Bistrița-Năsăud (10X)
  '101': { city: 'Bistrița',                county: 'Bistrița-Năsăud' }, // DGFP
  '102': { city: 'Beclean',                 county: 'Bistrița-Năsăud' }, // unverified
  '103': { city: 'Năsăud',                  county: 'Bistrița-Năsăud' }, // unverified
  '104': { city: 'Sîngeorz-Băi',            county: 'Bistrița-Năsăud' }, // unverified

  // Botoșani (11X)
  '111': { city: 'Botoșani',                county: 'Botoșani' },     // DGFP
  '112': { city: 'Dorohoi',                 county: 'Botoșani' },     // unverified
  '113': { city: 'Săveni',                  county: 'Botoșani' },     // unverified
  '114': { city: 'Darabani',                county: 'Botoșani' },     // unverified

  // Brașov (13X) — IBAN real confirmat: iban_TREZ130_TREZ131.pdf + Trezorerii.htm
  '130': { city: 'Brașov (Județeană)',      county: 'Brașov' },       // DGFP Brașov
  '131': { city: 'Brașov (Municipiu)',      county: 'Brașov' },       // IBAN real confirmat
  '132': { city: 'Făgăraș',                county: 'Brașov' },       // unverified
  '133': { city: 'Rupea',                   county: 'Brașov' },       // unverified
  '134': { city: 'Codlea',                  county: 'Brașov' },       // unverified
  '135': { city: 'Săcele',                  county: 'Brașov' },       // unverified
  '136': { city: 'Râșnov',                  county: 'Brașov' },       // unverified
  '137': { city: 'Zărnești',                county: 'Brașov' },       // unverified
  '138': { city: 'Victoria',                county: 'Brașov' },       // unverified
  '139': { city: 'Predeal',                 county: 'Brașov' },       // unverified

  // Brăila (15X)
  '151': { city: 'Brăila',                  county: 'Brăila' },       // DGFP
  '152': { city: 'Însurăței',               county: 'Brăila' },       // unverified
  '153': { city: 'Făurei',                  county: 'Brăila' },       // unverified
  '154': { city: 'Ianca',                   county: 'Brăila' },       // unverified

  // Buzău (16X)
  '161': { city: 'Buzău',                   county: 'Buzău' },        // DGFP
  '162': { city: 'Râmnicu Sărat',           county: 'Buzău' },        // unverified
  '163': { city: 'Pătârlagele',             county: 'Buzău' },        // unverified
  '164': { city: 'Pogoanele',               county: 'Buzău' },        // unverified

  // Caraș-Severin (17X)
  '171': { city: 'Reșița',                  county: 'Caraș-Severin' }, // DGFP
  '172': { city: 'Caransebeș',              county: 'Caraș-Severin' }, // unverified
  '173': { city: 'Oțelu Roșu',              county: 'Caraș-Severin' }, // unverified
  '174': { city: 'Oravița',                 county: 'Caraș-Severin' }, // unverified
  '175': { city: 'Moldova Nouă',            county: 'Caraș-Severin' }, // unverified
  '176': { city: 'Bozovici',                county: 'Caraș-Severin' }, // unverified

  // Călărași (21X)
  '211': { city: 'Călărași',                county: 'Călărași' },     // DGFP
  '212': { city: 'Oltenița',                county: 'Călărași' },     // unverified
  '213': { city: 'Lehliu Gară',             county: 'Călărași' },     // unverified
  '214': { city: 'Budești',                 county: 'Călărași' },     // unverified

  // Cluj (12X)
  '121': { city: 'Cluj-Napoca',             county: 'Cluj' },         // DGFP Cluj
  '122': { city: 'Dej',                     county: 'Cluj' },         // unverified
  '123': { city: 'Gherla',                  county: 'Cluj' },         // unverified
  '124': { city: 'Turda',                   county: 'Cluj' },         // unverified
  '125': { city: 'Huedin',                  county: 'Cluj' },         // unverified

  // Constanța (23X)
  '231': { city: 'Constanța',               county: 'Constanța' },    // DGFP
  '232': { city: 'Medgidia',                county: 'Constanța' },    // unverified
  '233': { city: 'Mangalia',                county: 'Constanța' },    // unverified
  '234': { city: 'Eforie',                  county: 'Constanța' },    // unverified
  '235': { city: 'Hârșova',                 county: 'Constanța' },    // unverified

  // Covasna (25X)
  '251': { city: 'Sfântu Gheorghe',         county: 'Covasna' },      // DGFP
  '252': { city: 'Târgu Secuiesc',          county: 'Covasna' },      // unverified
  '253': { city: 'Baraolt',                 county: 'Covasna' },      // unverified

  // Dâmbovița (26X)
  '261': { city: 'Târgoviște',              county: 'Dâmbovița' },    // DGFP
  '262': { city: 'Moreni',                  county: 'Dâmbovița' },    // unverified
  '263': { city: 'Titu',                    county: 'Dâmbovița' },    // unverified
  '264': { city: 'Pucioasa',                county: 'Dâmbovița' },    // unverified
  '265': { city: 'Găești',                  county: 'Dâmbovița' },    // unverified

  // Dolj (29X) — TREZ290/291 confirmată
  '290': { city: 'Craiova (Județeană)',     county: 'Dolj' },         // DGFP
  '291': { city: 'Craiova (Municipiu)',     county: 'Dolj' },         // IBAN real confirmat
  '292': { city: 'Segarcea',                county: 'Dolj' },         // unverified
  '293': { city: 'Băilești',                county: 'Dolj' },         // unverified
  '294': { city: 'Calafat',                 county: 'Dolj' },         // unverified
  '295': { city: 'Bechet',                  county: 'Dolj' },         // unverified
  '296': { city: 'Filiași',                 county: 'Dolj' },         // unverified

  // Galați (30X)
  '301': { city: 'Galați',                  county: 'Galați' },       // DGFP
  '302': { city: 'Tecuci',                  county: 'Galați' },       // unverified
  '303': { city: 'Târgu Bujor',             county: 'Galați' },       // unverified

  // Giurgiu (33X)
  '331': { city: 'Giurgiu',                 county: 'Giurgiu' },      // DGFP
  '332': { city: 'Bolintin-Vale',           county: 'Giurgiu' },      // unverified
  '333': { city: 'Mihăilești',              county: 'Giurgiu' },      // unverified

  // Gorj (32X)
  '321': { city: 'Târgu Jiu',               county: 'Gorj' },         // DGFP
  '322': { city: 'Rovinari',                county: 'Gorj' },         // unverified
  '323': { city: 'Novaci',                  county: 'Gorj' },         // unverified
  '324': { city: 'Târgu Cărbunești',        county: 'Gorj' },         // unverified
  '325': { city: 'Motru',                   county: 'Gorj' },         // unverified

  // Harghita (34X)
  '341': { city: 'Miercurea Ciuc',          county: 'Harghita' },     // DGFP
  '342': { city: 'Odorheiu Secuiesc',       county: 'Harghita' },     // unverified
  '343': { city: 'Gheorgheni',              county: 'Harghita' },     // unverified
  '344': { city: 'Toplița',                 county: 'Harghita' },     // unverified

  // Hunedoara (36X) — TREZ365 Deva confirmat
  '361': { city: 'Deva (Județeană)',        county: 'Hunedoara' },    // DGFP
  '365': { city: 'Deva (Municipiu)',        county: 'Hunedoara' },    // IBAN real confirmat
  '366': { city: 'Petroșani',               county: 'Hunedoara' },    // unverified
  '367': { city: 'Hunedoara',               county: 'Hunedoara' },    // unverified
  '368': { city: 'Brad',                    county: 'Hunedoara' },    // unverified
  '369': { city: 'Orăștie',                 county: 'Hunedoara' },    // unverified

  // Ialomița (38X)
  '381': { city: 'Slobozia',                county: 'Ialomița' },     // DGFP
  '382': { city: 'Urziceni',                county: 'Ialomița' },     // unverified
  '383': { city: 'Fetești',                 county: 'Ialomița' },     // unverified

  // Iași (39X)
  '391': { city: 'Iași',                    county: 'Iași' },         // DGFP
  '392': { city: 'Târgu Frumos',            county: 'Iași' },         // unverified
  '393': { city: 'Pașcani',                 county: 'Iași' },         // unverified
  '394': { city: 'Hârlău',                  county: 'Iași' },         // unverified
  '395': { city: 'Răducăneni',              county: 'Iași' },         // unverified

  // Ilfov (41X)
  '411': { city: 'Ilfov',                   county: 'Ilfov' },        // Trezoreria Județului Ilfov
  '412': { city: 'Bragadiru',               county: 'Ilfov' },        // unverified
  '413': { city: 'Buftea',                  county: 'Ilfov' },        // unverified

  // Maramureș (42X)
  '421': { city: 'Baia Mare',               county: 'Maramureș' },    // DGFP
  '422': { city: 'Sighetu Marmației',       county: 'Maramureș' },    // unverified
  '423': { city: 'Vișeu de Sus',            county: 'Maramureș' },    // unverified
  '424': { city: 'Târgu Lăpuș',             county: 'Maramureș' },    // unverified

  // Mehedinți (44X)
  '441': { city: 'Drobeta-Turnu Severin',   county: 'Mehedinți' },    // DGFP
  '442': { city: 'Orșova',                  county: 'Mehedinți' },    // unverified
  '443': { city: 'Baia de Aramă',           county: 'Mehedinți' },    // unverified
  '444': { city: 'Strehaia',                county: 'Mehedinți' },    // unverified
  '445': { city: 'Vânju Mare',              county: 'Mehedinți' },    // unverified

  // Mureș (47X, 48X) — TREZ479 Reghin, TREZ482 Sovata confirmate
  '471': { city: 'Târgu Mureș',             county: 'Mureș' },        // DGFP
  '472': { city: 'Sighișoara',              county: 'Mureș' },        // unverified
  '479': { city: 'Reghin',                  county: 'Mureș' },        // IBAN real confirmat
  '480': { city: 'Târnăveni',               county: 'Mureș' },        // unverified
  '481': { city: 'Luduș',                   county: 'Mureș' },        // unverified
  '482': { city: 'Sovata',                  county: 'Mureș' },        // IBAN real confirmat

  // Neamț (49X) — TREZ490/492 Roman confirmate
  '490': { city: 'Roman (Județeană)',       county: 'Neamț' },        // IBAN real confirmat
  '491': { city: 'Piatra Neamț',            county: 'Neamț' },        // DGFP
  '492': { city: 'Roman (Municipiu)',       county: 'Neamț' },        // IBAN real confirmat
  '493': { city: 'Târgu Neamț',             county: 'Neamț' },        // unverified
  '494': { city: 'Bicaz',                   county: 'Neamț' },        // unverified

  // Olt (50X)
  '501': { city: 'Slatina',                 county: 'Olt' },          // DGFP
  '502': { city: 'Caracal',                 county: 'Olt' },          // unverified
  '503': { city: 'Balș',                    county: 'Olt' },          // unverified
  '504': { city: 'Corabia',                 county: 'Olt' },          // unverified

  // Prahova (52X)
  '521': { city: 'Ploiești',                county: 'Prahova' },      // DGFP
  '522': { city: 'Câmpina',                 county: 'Prahova' },      // unverified
  '523': { city: 'Bușteni',                 county: 'Prahova' },      // unverified
  '524': { city: 'Mizil',                   county: 'Prahova' },      // unverified
  '525': { city: 'Slănic',                  county: 'Prahova' },      // unverified
  '526': { city: 'Vălenii de Munte',        county: 'Prahova' },      // unverified
  '527': { city: 'Boldești-Scăeni',         county: 'Prahova' },      // unverified

  // Satu Mare (55X)
  '551': { city: 'Satu Mare',               county: 'Satu Mare' },    // DGFP
  '552': { city: 'Carei',                   county: 'Satu Mare' },    // unverified
  '553': { city: 'Negrești-Oaș',            county: 'Satu Mare' },    // unverified
  '554': { city: 'Tășnad',                  county: 'Satu Mare' },    // unverified

  // Sălaj (57X)
  '571': { city: 'Zalău',                   county: 'Sălaj' },        // DGFP
  '572': { city: 'Șimleu Silvaniei',        county: 'Sălaj' },        // unverified
  '573': { city: 'Jibou',                   county: 'Sălaj' },        // unverified
  '574': { city: 'Cehu Silvaniei',          county: 'Sălaj' },        // unverified

  // Sibiu (58X)
  '581': { city: 'Sibiu',                   county: 'Sibiu' },        // DGFP
  '582': { city: 'Mediaș',                  county: 'Sibiu' },        // unverified
  '583': { city: 'Agnita',                  county: 'Sibiu' },        // unverified
  '584': { city: 'Avrig',                   county: 'Sibiu' },        // unverified
  '585': { city: 'Săliște',                 county: 'Sibiu' },        // unverified

  // Suceava (60X)
  '601': { city: 'Suceava',                 county: 'Suceava' },      // DGFP
  '602': { city: 'Fălticeni',               county: 'Suceava' },      // unverified
  '603': { city: 'Rădăuți',                 county: 'Suceava' },      // unverified
  '604': { city: 'Câmpulung Moldovenesc',   county: 'Suceava' },      // unverified
  '605': { city: 'Vatra Dornei',            county: 'Suceava' },      // unverified
  '606': { city: 'Gura Humorului',          county: 'Suceava' },      // unverified
  '607': { city: 'Siret',                   county: 'Suceava' },      // unverified

  // Teleorman (63X)
  '631': { city: 'Alexandria',              county: 'Teleorman' },    // DGFP
  '632': { city: 'Turnu Măgurele',          county: 'Teleorman' },    // unverified
  '633': { city: 'Roșiori de Vede',         county: 'Teleorman' },    // unverified
  '634': { city: 'Videle',                  county: 'Teleorman' },    // unverified
  '635': { city: 'Zimnicea',                county: 'Teleorman' },    // unverified

  // Timiș (64X)
  '641': { city: 'Timișoara',               county: 'Timiș' },        // DGFP
  '642': { city: 'Lugoj',                   county: 'Timiș' },        // unverified
  '643': { city: 'Buziaș',                  county: 'Timiș' },        // unverified
  '644': { city: 'Deta',                    county: 'Timiș' },        // unverified
  '645': { city: 'Făget',                   county: 'Timiș' },        // unverified
  '646': { city: 'Jimbolia',                county: 'Timiș' },        // unverified
  '647': { city: 'Sânnicolau Mare',         county: 'Timiș' },        // unverified

  // Tulcea (66X)
  '661': { city: 'Tulcea',                  county: 'Tulcea' },       // DGFP
  '662': { city: 'Babadag',                 county: 'Tulcea' },       // unverified
  '663': { city: 'Măcin',                   county: 'Tulcea' },       // unverified
  '664': { city: 'Sulina',                  county: 'Tulcea' },       // unverified
  '665': { city: 'Baia',                    county: 'Tulcea' },       // unverified

  // Vaslui (67X)
  '671': { city: 'Vaslui',                  county: 'Vaslui' },       // DGFP
  '672': { city: 'Bârlad',                  county: 'Vaslui' },       // unverified
  '673': { city: 'Huși',                    county: 'Vaslui' },       // unverified
  '674': { city: 'Negrești',                county: 'Vaslui' },       // unverified

  // Vâlcea (69X)
  '691': { city: 'Râmnicu Vâlcea',          county: 'Vâlcea' },       // DGFP
  '692': { city: 'Drăgășani',               county: 'Vâlcea' },       // unverified
  '693': { city: 'Băbeni',                  county: 'Vâlcea' },       // unverified
  '694': { city: 'Bălcești',                county: 'Vâlcea' },       // unverified
  '695': { city: 'Brezoi',                  county: 'Vâlcea' },       // unverified
  '696': { city: 'Horezu',                  county: 'Vâlcea' },       // unverified

  // Vrancea (71X)
  '711': { city: 'Focșani',                 county: 'Vrancea' },      // DGFP
  '712': { city: 'Adjud',                   county: 'Vrancea' },      // unverified
  '713': { city: 'Panciu',                  county: 'Vrancea' },      // unverified

  // București (70X) — ATCPMB + sectoare
  '700': { city: 'București (ATCPMB)',      county: 'București' },    // Activitatea de Trezorerie
  '701': { city: 'București Sector 1',      county: 'București' },    // Trezoreria Sector 1
  '702': { city: 'București Sector 2',      county: 'București' },    // unverified
  '703': { city: 'București Sector 3',      county: 'București' },    // IBAN real confirmat
  '704': { city: 'București Sector 4',      county: 'București' },    // unverified
  '705': { city: 'București Sector 5',      county: 'București' },    // unverified
  '706': { city: 'București Sector 6',      county: 'București' },    // unverified
};

// Fallback pe 2 cifre (județ) când codul de 3 cifre nu e în mapping.
const TREZ_COUNTY_FALLBACK = {
  '00': 'Alba',         '02': 'Arad',         '04': 'Argeș',        '06': 'Bacău',
  '08': 'Bihor',        '10': 'Bistrița-Năsăud', '11': 'Botoșani',  '13': 'Brașov',
  '15': 'Brăila',       '16': 'Buzău',        '17': 'Caraș-Severin', '12': 'Cluj',
  '21': 'Călărași',     '23': 'Constanța',    '25': 'Covasna',      '26': 'Dâmbovița',
  '29': 'Dolj',         '30': 'Galați',       '32': 'Gorj',         '33': 'Giurgiu',
  '34': 'Harghita',     '36': 'Hunedoara',    '38': 'Ialomița',     '39': 'Iași',
  '41': 'Ilfov',        '42': 'Maramureș',    '44': 'Mehedinți',    '47': 'Mureș',
  '48': 'Mureș',        '49': 'Neamț',        '50': 'Olt',          '52': 'Prahova',
  '55': 'Satu Mare',    '57': 'Sălaj',        '58': 'Sibiu',        '60': 'Suceava',
  '63': 'Teleorman',    '64': 'Timiș',        '66': 'Tulcea',       '67': 'Vaslui',
  '69': 'Vâlcea',       '70': 'București',    '71': 'Vrancea',
};

const RO_BANK_CODES = {
  TREZ: { name: 'Trezoreria Statului', type: 'treasury' },
  BTRL: { name: 'Banca Transilvania', type: 'commercial' },
  BRDE: { name: 'BRD - Groupe Société Générale', type: 'commercial' },
  RNCB: { name: 'Banca Comercială Română (BCR)', type: 'commercial' },
  RZBR: { name: 'Raiffeisen Bank', type: 'commercial' },
  INGB: { name: 'ING Bank', type: 'commercial' },
  OTPV: { name: 'OTP Bank', type: 'commercial' },
  BUCU: { name: 'Alpha Bank', type: 'commercial' },
  UGBI: { name: 'Garanti BBVA', type: 'commercial' },
  UNCR: { name: 'UniCredit Bank', type: 'commercial' },
  BREL: { name: 'Libra Internet Bank', type: 'commercial' },
  CECE: { name: 'CEC Bank', type: 'commercial' },
  CITI: { name: 'Citibank Europe', type: 'commercial' },
  CARP: { name: 'Credit Europe Bank', type: 'commercial' },
  WBAN: { name: 'Exim Banca Românească', type: 'commercial' },
  BCOR: { name: 'Salt Bank / BCR', type: 'commercial' },
  ETBK: { name: 'Banca Românească', type: 'commercial' },
  EGNA: { name: 'Intesa Sanpaolo Bank', type: 'commercial' },
  BFER: { name: 'First Bank', type: 'commercial' },
  PBKR: { name: 'ProCredit Bank', type: 'commercial' },
  MILB: { name: 'Vista Bank', type: 'commercial' },
  DAFB: { name: 'Banca Comercială Feroviara', type: 'commercial' },
  PIRB: { name: 'Piraeus Bank (exit)', type: 'commercial' },
};

function normalizeIban(raw) {
  if (!raw) return null;
  return String(raw).toUpperCase().replace(/\s+/g, '');
}

function checkMod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    if (/[0-9]/.test(ch)) numeric += ch;
    else if (/[A-Z]/.test(ch)) numeric += (ch.charCodeAt(0) - 55).toString();
    else return false;
  }
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function verifyIban(rawIban) {
  const iban = normalizeIban(rawIban);
  if (!iban) return { ok: false, reason: 'iban_empty' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return { ok: false, reason: 'iban_format_invalid' };
  const country = iban.slice(0, 2);
  if (country !== 'RO') {
    return {
      ok: true,
      data: { iban, valid: checkMod97(iban), country, bankCode: null, bankName: null, accountType: 'foreign', isTreasury: false },
    };
  }
  if (iban.length !== 24) return { ok: false, reason: 'iban_ro_length_invalid' };
  const valid = checkMod97(iban);
  const bankCode = iban.slice(4, 8);
  const bank = RO_BANK_CODES[bankCode];
  const isTreasury = bankCode === 'TREZ';

  let treasuryCity = null;
  let treasuryCounty = null;
  let treasuryBranchName = null;

  if (isTreasury) {
    const localityCode = iban.slice(8, 11);  // 3 cifre
    const countyCode = iban.slice(8, 10);    // 2 cifre fallback

    const localityEntry = TREZ_LOCALITY_CODES[localityCode];
    if (localityEntry) {
      treasuryCity = localityEntry.city;
      treasuryCounty = localityEntry.county;
      treasuryBranchName = `Trezoreria ${localityEntry.city}`;
    } else if (TREZ_COUNTY_FALLBACK[countyCode]) {
      treasuryCounty = TREZ_COUNTY_FALLBACK[countyCode];
      treasuryBranchName = `Trezoreria jud. ${treasuryCounty} (cod ${localityCode})`;
    } else {
      treasuryBranchName = `Trezoreria Statului (cod ${localityCode})`;
    }
  }

  return {
    ok: true,
    data: {
      iban,
      valid,
      country: 'RO',
      bankCode,
      bankName: isTreasury ? treasuryBranchName : (bank ? bank.name : 'Bancă necunoscută'),
      accountType: bank ? bank.type : (isTreasury ? 'treasury' : 'unknown'),
      isTreasury,
      treasuryCity,
      treasuryCounty,
    },
  };
}
