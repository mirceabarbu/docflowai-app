// Mapper rând DB plat -> obiect DF XSD-shaped (df-to-xsd.mjs), PORTUL backend al `colN()`.
// Dovedim: (1) echivalența structurală — un rând DB plat produce EXACT forma XSD pe care o
// construia frontend-ul; (2) lanțul complet rând DB -> serializeNotafd -> validateXml e valid.

import { describe, it, expect } from 'vitest';
import { dfRowToXsd } from '../../services/alop-xml/df-to-xsd.mjs';
import { serializeNotafd } from '../../services/alop-xml/notafd-serializer.mjs';
import { validateXml } from '../../services/alop-xml/validate.mjs';

// Rând DB plat realist (coloanele formulare_df). Rândurile JSONB folosesc cheile XSD (din `data-f`).
const dbRow = {
  id: 'df-1', org_id: 1, status: 'completed',
  cif: '4221306', den_inst_pb: 'Primăria Comunei Exemplu', subtitlu_df: 'Achiziție licență IT',
  nr_unic_inreg: 'DF-2026-0002', revizuirea: '0', data_revizuirii: '15.01.2026',
  compartiment_specialitate: 'Compartiment IT',
  obiect_fd_reviz_scurt: 'Achiziție licență software',
  obiect_fd_reviz_lung: 'Achiziția unei licențe IT necesară activității curente.',
  ckbx_stab_tin_cont: '1', ckbx_ramane_suma: '', ramane_suma: '0',
  rows_val: [
    { element_fd: 'Licență IT', program: '6102', codSSI: '20.01.30', param_fd: '1 buc',
      valt_rev_prec: '0', influente: '560', valt_actualiz: '560' },
  ],
  ckbx_fara_ang_emis_ancrt: '', ckbx_cu_ang_emis_ancrt: '1', ckbx_sting_ang_in_ancrt: '',
  ckbx_fara_plati_ang_in_ancrt: '', ckbx_cu_plati_ang_in_mmani: '1', ckbx_ang_leg_emise_ct_an_urm: '',
  rows_plati: [{ program: '6102', codSSI: '20.01.30', plati_estim_ancrt: '560' }],
  ckbx_secta_inreg_ctrl_ang: '1', ckbx_fara_inreg_ctrl_ang: '',
  sum_fara_inreg_ctrl_crdbug: '0',
  sum_fara_inreg_ctrl_crd_bug: '0', // pereche 2 (intern) — NU trebuie să apară în XSD-shape
  ckbx_interzis_emit_ang: '', ckbx_interzis_intrucat: '', intrucat: '',
  rows_ctrl: [
    { cod_angajament: '20260002', indicator_angajament: 'A', program: '6102', cod_SSI: '20.01.30',
      sum_rezv_crdt_ang_act: '560', sum_rezv_crdt_bug_act: '560' },
  ],
};

describe('dfRowToXsd — echivalență cu forma colN() + lanț valid XSD', () => {
  it('produce EXACT forma XSD-shaped așteptată de serializeNotafd', () => {
    expect(dfRowToXsd(dbRow)).toEqual({
      Cif: '4221306',
      DenInstPb: 'Primăria Comunei Exemplu',
      SubtitluDF: 'Achiziție licență IT',
      NrUnicInreg: 'DF-2026-0002',
      Revizuirea: '0',
      DataRevizuirii: '15.01.2026',
      sectiuneaA: {
        compartiment_specialitate: 'Compartiment IT',
        obiect_fd_reviz_scurt: 'Achiziție licență software',
        obiect_fd_reviz_lung: 'Achiziția unei licențe IT necesară activității curente.',
        ang_legale_val: {
          ckbx_stab_tin_cont: '1', ckbx_ramane_suma: '', ramane_suma: '0',
          rowT_ang_pl_val: dbRow.rows_val,
        },
        ang_legale_plati: {
          ckbx_fara_ang_emis_ancrt: '', ckbx_cu_ang_emis_ancrt: '1', ckbx_sting_ang_in_ancrt: '',
          ckbx_fara_plati_ang_in_ancrt: '', ckbx_cu_plati_ang_in_mmani: '1', ckbx_ang_leg_emise_ct_an_urm: '',
          rowT_ang_pl_plati: dbRow.rows_plati,
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: '1', ckbx_fara_inreg_ctrl_ang: '',
        sum_fara_inreg_ctrl_crdbug: '0',
        ckbx_interzis_emit_ang: '', ckbx_interzis_intrucat: '', intrucat: '',
        rowT_ang_ctrl_ang: dbRow.rows_ctrl,
      },
    });
  });

  it('NU expune câmpul intern sum_fara_inreg_ctrl_crd_bug (pereche 2, fără corespondent XSD)', () => {
    expect(dfRowToXsd(dbRow).sectiuneaB).not.toHaveProperty('sum_fara_inreg_ctrl_crd_bug');
  });

  it('coloane lipsă/null -> stringuri goale / array gol (fără crash)', () => {
    const xsd = dfRowToXsd({ cif: '4221306' });
    expect(xsd.DenInstPb).toBe('');
    expect(xsd.sectiuneaA.ang_legale_val.rowT_ang_pl_val).toEqual([]);
    expect(xsd.sectiuneaB.rowT_ang_ctrl_ang).toEqual([]);
  });

  it('lanț complet: rând DB -> serializeNotafd -> validateXml === valid', async () => {
    const xml = serializeNotafd(dfRowToXsd(dbRow));
    const { valid, errors } = await validateXml(xml, 'notafd_v0');
    if (!valid) throw new Error('XML invalid:\n' + JSON.stringify(errors, null, 2) + '\n' + xml);
    expect(valid).toBe(true);
  });

  it('aruncă pe input non-obiect', () => {
    expect(() => dfRowToXsd(null)).toThrow();
  });
});
