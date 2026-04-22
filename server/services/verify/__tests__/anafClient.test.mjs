import { describe, it, expect } from 'vitest';
import { parseAnafRecord } from '../anafClient.mjs';

// Fixture: record real din ANAF v9 pentru BRACOMA SRL (cui 13265409) — Railway logs 22.04.2026
const BRACOMA_RECORD = {
  date_generale: {
    data: '2026-04-21',
    cui: 13265409,
    denumire: 'BRACOMA SRL',
    adresa: 'JUD. BRASOV, ORS. RÂSNOV, STR. ION LUCA CARAGIALE, NR.141, CAMERA 2',
    telefon: '0268238086',
    fax: '',
    codPostal: '505400',
    act: '',
    stare_inregistrare: 'INREGISTRAT din data 09.08.2000',
    data_inreg_Reg_RO_e_Factura: '2022-07-01',
    organFiscalCompetent: 'Unitatea Fiscală Orășenească Râșnov',
    forma_de_proprietate: 'PROPR.PRIVATA-CAPITAL PRIVAT AUTOHTON',
    forma_organizare: 'PERSOANA JURIDICA',
    forma_juridica: 'SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ',
    statusRO_e_Factura: true,
    data_inregistrare: '2000-08-09',
    nrRegCom: 'J08/687/2000',
    cod_CAEN: '4773',
    iban: '',
  },
  inregistrare_scop_Tva: {
    scpTVA: true,
    perioade_TVA: [{ data_inceput_ScpTVA: '2000-08-09', data_sfarsit_ScpTVA: '', data_anul_imp_ScpTVA: '', mesaj_ScpTVA: '' }],
  },
  inregistrare_RTVAI: {
    dataInceputTvaInc: '2013-01-01',
    dataSfarsitTvaInc: '2021-05-01',
    dataActualizareTvaInc: '2021-04-13',
    dataPublicareTvaInc: '2021-04-14',
    tipActTvaInc: 'Radiere',
    statusTvaIncasare: false,
  },
  stare_inactiv: {
    dataInactivare: '',
    dataReactivare: '',
    dataPublicare: '',
    dataRadiere: '',
    statusInactivi: false,
  },
  inregistrare_SplitTVA: {
    dataInceputSplitTVA: '',
    dataAnulareSplitTVA: '',
    statusSplitTVA: false,
  },
  adresa_sediu_social: {
    sdenumire_Strada: 'Str. Ion Luca Caragiale',
    snumar_Strada: '141',
    scod_Localitate: '146',
    sdenumire_Localitate: 'Orș. Râșnov',
    sdenumire_Judet: 'BRAȘOV',
    scod_Judet: '8',
    scod_JudetAuto: 'BV',
    sdetalii_Adresa: 'CAMERA 2',
    scod_Postal: '505400',
    stara: '',
  },
  adresa_domiciliu_fiscal: {
    ddenumire_Localitate: 'Orș. Râșnov',
    ddenumire_Strada: 'Str. Ion Luca Caragiale',
    dnumar_Strada: '141',
    dcod_Localitate: '146',
    ddenumire_Judet: 'BRAȘOV',
    dcod_Judet: '8',
    dcod_JudetAuto: 'BV',
    ddetalii_Adresa: 'CAMERA 2',
    dcod_Postal: '505400',
    dtara: '',
  },
};

describe('parseAnafRecord', () => {
  it('întoarce null pentru input null/undefined', () => {
    expect(parseAnafRecord(null)).toBe(null);
    expect(parseAnafRecord(undefined)).toBe(null);
  });

  it('parsează complet record real BRACOMA SRL', () => {
    const r = parseAnafRecord(BRACOMA_RECORD);
    expect(r.cui).toBe('13265409');
    expect(r.name).toBe('BRACOMA SRL');
    expect(r.entityType).toBe('SRL');
    expect(r.county).toBe('BRAȘOV');
    expect(r.countyAuto).toBe('BV');
    expect(r.countyCode).toBe('8');
    expect(r.locality).toBe('Orș. Râșnov');
    expect(r.tradeRegisterNo).toBe('J08/687/2000');
    expect(r.caenCode).toBe('4773');
    expect(r.registrationDate).toBe('2000-08-09');
    expect(r.vat).toBe(true);
    expect(r.vatStartDate).toBe('2000-08-09');
    expect(r.vatEndDate).toBeNull();
    expect(r.vatPeriods).toHaveLength(1);
    expect(r.vatPeriods[0]).toMatchObject({ data_inceput_ScpTVA: '2000-08-09' });
    expect(r.vatCollected).toBe(false);
    expect(r.vatCollectedStartDate).toBe('2013-01-01');
    expect(r.vatCollectedEndDate).toBe('2021-05-01');
    expect(r.inactive).toBe(false);
    expect(r.radiated).toBe(false);
    expect(r.eFactura).toBe(true);
    expect(r.fiscalAuthority).toContain('Râșnov');
    expect(r.splitVat).toBe(false);
  });

  it('compune adresă lizibilă din sediu_social cu toate elementele', () => {
    const r = parseAnafRecord(BRACOMA_RECORD);
    expect(r.address).toContain('Str. Ion Luca Caragiale');
    expect(r.address).toContain('141');
    expect(r.address).toContain('CAMERA 2');
    expect(r.address).toContain('Orș. Râșnov');
    expect(r.address).toContain('jud. BRAȘOV');
  });

  it('marchează firmă radiată când dataRadiere e prezentă', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '2024-06-15';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('2024-06-15');
    expect(r.inactive).toBe(false);
  });

  it('marchează firmă inactivă (statusInactivi=true, fără radiere)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.statusInactivi = true;
    rec.stare_inactiv.dataInactivare = '2024-01-10';
    const r = parseAnafRecord(rec);
    expect(r.inactive).toBe(true);
    expect(r.radiated).toBe(false);
    expect(r.inactiveDate).toBe('2024-01-10');
  });

  it('detectează instituție publică din denumire (forma_juridica goală)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.date_generale.denumire = 'PRIMARIA MUNICIPIULUI BRASOV';
    rec.date_generale.forma_juridica = '';
    const r = parseAnafRecord(rec);
    expect(r.entityType).toBe('public');
  });

  it('detectează PFA din forma_juridica', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.date_generale.forma_juridica = 'PERSOANA FIZICA AUTORIZATA';
    rec.date_generale.denumire = 'IONESCU GHEORGHE';  // fără SRL în denumire
    const r = parseAnafRecord(rec);
    expect(r.entityType).toBe('PFA');
  });

  it('detectează SA din forma_juridica', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.date_generale.forma_juridica = 'SOCIETATE PE ACTIUNI';
    rec.date_generale.denumire = 'EXEMPLU CORP';  // fără SRL în denumire
    const r = parseAnafRecord(rec);
    expect(r.entityType).toBe('SA');
  });

  it('fallback județ pe domiciliu_fiscal dacă sediu_social e gol', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.adresa_sediu_social = {};
    const r = parseAnafRecord(rec);
    expect(r.county).toBe('BRAȘOV');
    expect(r.countyAuto).toBe('BV');
    expect(r.locality).toBe('Orș. Râșnov');
  });

  it('adresă fallback pe dg.adresa când sediu_social e gol', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.adresa_sediu_social = {};
    const r = parseAnafRecord(rec);
    // cu sediu_social gol, cleanAddress e '' → fallback la dg.adresa
    expect(r.address).toBe(BRACOMA_RECORD.date_generale.adresa);
  });

  it('parsează TVA la încasare cu date start/end', () => {
    const r = parseAnafRecord(BRACOMA_RECORD);
    expect(r.vatCollectedStartDate).toBe('2013-01-01');
    expect(r.vatCollectedEndDate).toBe('2021-05-01');
  });

  it('detectează radiere din stare_inregistrare când dataRadiere e gol', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'RADIATĂ din data 15.06.2024';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('15.06.2024');
    expect(r.stareInregistrareText).toBe('RADIATĂ din data 15.06.2024');
  });

  it('detectează radiere cu variantă fără diacritice', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'RADIATA din data 20.03.2023';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('20.03.2023');
  });

  it('detectează stare_inregistrare="RADIERE din data X" (cazul real MIRCOMIR SRL)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'RADIERE din data 23.07.2013';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('23.07.2013');
  });

  it('detectează RADIATĂ (forma feminină cu diacritic)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'RADIATĂ din data 10.05.2022';
    expect(parseAnafRecord(rec).radiated).toBe(true);
  });

  it('detectează RADIERII (forma genitivă)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'În curs de RADIERII conform sentinței';
    expect(parseAnafRecord(rec).radiated).toBe(true);
  });

  it('NU matchează cuvinte care conțin RADIA în interiorul unui alt cuvânt', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'PARADIATA SOCIETATE INREGISTRATA';
    expect(parseAnafRecord(rec).radiated).toBe(false);
  });

  it('case-insensitive: "radiere" lowercase tot e detectat', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '';
    rec.date_generale.stare_inregistrare = 'radiere din data 01.01.2020';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('01.01.2020');
  });

  it('preferă dataRadiere dacă ambele surse sunt prezente', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.stare_inactiv.dataRadiere = '2024-06-15';
    rec.date_generale.stare_inregistrare = 'RADIATĂ din data 10.06.2024';
    const r = parseAnafRecord(rec);
    expect(r.radiated).toBe(true);
    expect(r.liquidationDate).toBe('2024-06-15');
  });

  it('nu marchează radiată pentru firmă activă (INREGISTRAT)', () => {
    const r = parseAnafRecord(BRACOMA_RECORD);
    expect(r.radiated).toBe(false);
    expect(r.stareInregistrareText).toContain('INREGISTRAT');
  });

  it('expune _raw cu toate sub-secțiunile ANAF', () => {
    const r = parseAnafRecord(BRACOMA_RECORD);
    expect(r._raw).toBeDefined();
    expect(r._raw.date_generale).toBeDefined();
    expect(r._raw.inregistrare_scop_Tva).toBeDefined();
    expect(r._raw.stare_inactiv).toBeDefined();
    expect(r._raw.adresa_sediu_social).toBeDefined();
    expect(r._raw.date_generale.cui).toBe(13265409);
  });

  it('parsează corect perioade_TVA array — firmă cu TVA anulat (structură MIRCOMIR)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.inregistrare_scop_Tva = {
      scpTVA: false,
      perioade_TVA: [
        { data_inceput_ScpTVA: '2001-01-01', data_sfarsit_ScpTVA: '2013-07-23', data_anul_imp_ScpTVA: '2013-07-23', mesaj_ScpTVA: 'Conform art.153 alin.(9) lit.d) din Codul fiscal' },
      ],
    };
    const r = parseAnafRecord(rec);
    expect(r.vat).toBe(false);
    expect(r.vatStartDate).toBe('2001-01-01');
    expect(r.vatEndDate).toBe('2013-07-23');
    expect(r.vatCancelDate).toBe('2013-07-23');
    expect(r.vatCancelReason).toContain('art.153');
    expect(r.vatPeriods).toHaveLength(1);
  });

  it('parsează istoric multiplu de perioade TVA — ultima e cea relevantă', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.inregistrare_scop_Tva = {
      scpTVA: true,
      perioade_TVA: [
        { data_inceput_ScpTVA: '2001-01-01', data_sfarsit_ScpTVA: '2005-06-30', data_anul_imp_ScpTVA: '', mesaj_ScpTVA: '' },
        { data_inceput_ScpTVA: '2007-03-01', data_sfarsit_ScpTVA: '', data_anul_imp_ScpTVA: '', mesaj_ScpTVA: '' },
      ],
    };
    const r = parseAnafRecord(rec);
    expect(r.vatPeriods).toHaveLength(2);
    // Ultima perioadă (index 1) este cea mai recentă
    expect(r.vatStartDate).toBe('2007-03-01');
    expect(r.vatEndDate).toBeNull();
  });

  it('tratează lipsa perioade_TVA (firmă neplătitoare fără istoric)', () => {
    const rec = JSON.parse(JSON.stringify(BRACOMA_RECORD));
    rec.inregistrare_scop_Tva = { scpTVA: false };
    const r = parseAnafRecord(rec);
    expect(r.vat).toBe(false);
    expect(r.vatStartDate).toBeNull();
    expect(r.vatEndDate).toBeNull();
    expect(r.vatCancelDate).toBeNull();
    expect(r.vatCancelReason).toBe('');
    expect(r.vatPeriods).toEqual([]);
  });
});
