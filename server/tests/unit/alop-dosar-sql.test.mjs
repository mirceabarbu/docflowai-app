/**
 * #134e — server/services/alop-dosar-sql.mjs, verificare PUR TEXTUALĂ.
 *
 * Fragmentele ajung în `SQL_ALOP_BADGE`, care se folosește ȘI în WHERE-ul de COUNT
 * din `GET /api/alop` — interogare FĂRĂ NICIUN JOIN (#121). O singură referință la
 * aliasul `df` (sau la orice alias de join) ar sparge COUNT-ul în producție, iar un
 * backtick ar rupe template literal-ul în care fragmentele se interpolează (#134b).
 * De-aia poarta e aici, nu doar în testele DB.
 */
import { describe, it, expect } from 'vitest';
import {
  sqlFdInDosar, sqlDosarAreFluxActiv, sqlDosarAreAprobat,
  sqlRevizieInLucruId, sqlRevizieInLucruNr,
  sqlRevizieInVigoareId, sqlRevizieInVigoareNr,
} from '../../services/alop-dosar-sql.mjs';
import { dfAprobatSql } from '../../services/df-aprobat-sql.mjs';

const TOATE = () => ({
  sqlFdInDosar: sqlFdInDosar(),
  sqlDosarAreFluxActiv: sqlDosarAreFluxActiv(),
  sqlDosarAreAprobat: sqlDosarAreAprobat(),
  sqlRevizieInLucruId: sqlRevizieInLucruId(),
  sqlRevizieInLucruNr: sqlRevizieInLucruNr(),
  sqlRevizieInVigoareId: sqlRevizieInVigoareId(),
  sqlRevizieInVigoareNr: sqlRevizieInVigoareNr(),
});

describe('#134e — alop-dosar-sql: fragmente corelate pe DOSAR', () => {
  it('1. aliasurile IMPLICITE produc fragmente nevide, corelate pe a.*', () => {
    for (const [nume, frag] of Object.entries(TOATE())) {
      expect(frag, nume).toBeTruthy();
      expect(frag, nume).toContain('a.');
    }
  });

  it('2. aliasurile PERSONALIZATE se propagă în tot fragmentul', () => {
    const fd = sqlFdInDosar('xx', 'yy');
    expect(fd).toContain('xx.source_alop_id = yy.id');
    expect(fd).toContain('xx.org_id = yy.org_id');
    expect(fd).not.toContain('fd.');

    for (const f of [sqlDosarAreFluxActiv('zz'), sqlDosarAreAprobat('zz'),
                     sqlRevizieInLucruId('zz'), sqlRevizieInLucruNr('zz'),
                     sqlRevizieInVigoareId('zz'), sqlRevizieInVigoareNr('zz')]) {
      expect(f).toContain('zz.');
      // niciun fragment nu mai poate referi aliasul implicit `a` când i se dă altul
      expect(f).not.toMatch(/\ba\.(id|org_id|df_id|df_flow_id)\b/);
    }
  });

  it('3. sqlFdInDosar are AMBELE ramuri: proveniență + legacy strict pe source_alop_id NULL', () => {
    const fd = sqlFdInDosar();
    expect(fd).toContain('fd.source_alop_id = a.id');              // ramura principală
    expect(fd).toContain('fd.source_alop_id IS NULL');             // ramura legacy
    expect(fd).toContain('fd.nr_unic_inreg = (SELECT d0.nr_unic_inreg');
    expect(fd).toContain('fd.org_id = a.org_id');                  // legacy NU sare peste org
  });

  it('4. `deleted_at IS NULL` pe formulare_df e prezent în TOATE fragmentele care citesc dosarul', () => {
    for (const [nume, frag] of Object.entries(TOATE())) {
      expect(frag, nume).toMatch(/\.deleted_at IS NULL/);
    }
  });

  it('5. ⭐ POARTA ANTI-COUNT: zero referințe la aliasul `df` (sau la orice JOIN al listei)', () => {
    for (const [nume, frag] of Object.entries(TOATE())) {
      expect(frag, `${nume} referă aliasul df — ar sparge COUNT-ul fără join`).not.toMatch(/\bdf\./);
      for (const alias of ['fo.', 'u.', 'f1.', 'f2.', 'dfx.']) {
        expect(frag, `${nume} referă ${alias}`).not.toContain(alias);
      }
    }
  });

  it('6. zero backtick-uri (fragmentele se interpolează în template literal-e)', () => {
    for (const [nume, frag] of Object.entries(TOATE())) {
      expect(frag, nume).not.toContain('`');
    }
  });

  it('7. parantezele sunt echilibrate și fiecare fragment e complet parantezat', () => {
    for (const [nume, frag] of Object.entries(TOATE())) {
      let d = 0;
      for (const ch of frag) {
        if (ch === '(') d++;
        else if (ch === ')') d--;
        expect(d, `${nume}: paranteză închisă în plus`).toBeGreaterThanOrEqual(0);
      }
      expect(d, `${nume}: paranteze neechilibrate`).toBe(0);
      expect(frag.trim().startsWith('('), nume).toBe(true);
      expect(frag.trim().endsWith(')'), nume).toBe(true);
    }
  });

  it('8. sqlDosarAreAprobat REFOLOSEȘTE dfAprobatSql (#134d), nu rescrie definiția', () => {
    const frag = sqlDosarAreAprobat();
    expect(frag).toContain(dfAprobatSql('fdap', 'fap'));
  });

  it('9. „revizie în lucru" filtrează revizie_nr > 0 și ordonează descrescător (ambele fragmente)', () => {
    for (const frag of [sqlRevizieInLucruId(), sqlRevizieInLucruNr()]) {
      expect(frag).toContain('COALESCE(fdrl.revizie_nr, 0) > 0');
      expect(frag).toContain('ORDER BY fdrl.revizie_nr DESC, fdrl.created_at DESC');
      expect(frag).toContain('LIMIT 1');
      // „nu e aprobată" = negarea definiției #134d, nu un status hardcodat
      expect(frag).toContain('NOT EXISTS');
      expect(frag).toContain(dfAprobatSql('fdrl', 'frl'));
    }
  });

  it('10. Id vs Nr diferă DOAR prin coloana proiectată', () => {
    const id = sqlRevizieInLucruId();
    const nr = sqlRevizieInLucruNr();
    expect(id).toContain('SELECT fdrl.id FROM formulare_df fdrl');
    expect(nr).toContain('SELECT fdrl.revizie_nr FROM formulare_df fdrl');
    expect(id.replace('SELECT fdrl.id ', 'SELECT fdrl.revizie_nr ')).toBe(nr);
  });

  it('11. „flux activ" păstrează cele patru gărzi de flux viu', () => {
    const frag = sqlDosarAreFluxActiv();
    expect(frag).toContain("(ffa.data->>'completed') IS DISTINCT FROM 'true'");
    expect(frag).toContain("(ffa.data->>'status')    IS DISTINCT FROM 'cancelled'");
    expect(frag).toContain("(ffa.data->>'status')    IS DISTINCT FROM 'refused'");
    expect(frag).toContain('ffa.deleted_at IS NULL');
  });

  it('12. #135 — „revizie în vigoare" e complementara EXACTĂ a „revizie în lucru"', () => {
    expect(sqlRevizieInVigoareNr()).toContain('EXISTS (');
    expect(sqlRevizieInLucruNr()).toContain('NOT EXISTS (');
  });
});
