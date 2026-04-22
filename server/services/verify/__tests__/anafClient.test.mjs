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
});
