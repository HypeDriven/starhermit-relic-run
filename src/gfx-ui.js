// Relic Run - Settings > Graphics panel: quality preset, render scale, one
// override per effect, adaptive resolution, frame-rate readout and a cost
// summary. The rest of the game has no i18n system, so this panel localizes its
// own strings from navigator.language.
import { PRESETS, CATEGORIES, resolve, presetTier, applyPreset, describe } from './gfx.js';

const EN = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', renderScale: 'Render scale',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate', fromPreset: 'From preset ({tier})',
  postFailed: 'Post-processing is unavailable on this device, so the game renders without it.',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
    foliage: 'Foliage density', detail: 'Surface detail', particles: 'Fireflies & pollen', wind: 'Wind sway',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    sparse: 'Sparse', normal: 'Normal', dense: 'Dense', plain: 'Plain', detailed: 'Detailed',
  },
  words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'AO', fullAo: 'full AO', bloom: 'bloom', noAA: 'no AA' },
};

const ES = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automático (detectado: {tier})', renderScale: 'Escala de renderizado',
  adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo', fromPreset: 'Según el ajuste ({tier})',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
  presets: { low: 'Bajo', balanced: 'Equilibrado', high: 'Alto', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing',
    foliage: 'Densidad del follaje', detail: 'Detalle de superficies', particles: 'Luciérnagas y polen', wind: 'Balanceo con el viento',
  },
  tiers: {
    off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    sparse: 'Escaso', normal: 'Normal', dense: 'Denso', plain: 'Simple', detailed: 'Detallado',
  },
  words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'OA', fullAo: 'OA completa', bloom: 'resplandor', noAA: 'sin AA' },
};

const FR = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détecté : {tier})', renderScale: 'Échelle de rendu',
  adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images', fromPreset: 'Selon le préréglage ({tier})',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans.',
  presets: { low: 'Faible', balanced: 'Équilibré', high: 'Élevé', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
    foliage: 'Densité du feuillage', detail: 'Détail des surfaces', particles: 'Lucioles et pollen', wind: 'Balancement au vent',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Faible', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    sparse: 'Clairsemé', normal: 'Normal', dense: 'Dense', plain: 'Simple', detailed: 'Détaillé',
  },
  words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'OA', fullAo: 'OA complète', bloom: 'halo', noAA: 'sans AA' },
};

export const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cats: { ...EN.cats, grade: 'Colour grade' } },
  'es-419': ES,
  'es-ES': { ...ES, cats: { ...ES.cats, foliage: 'Densidad de la vegetación' } },
  'de-DE': {
    graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', renderScale: 'Renderskalierung',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen', fromPreset: 'Aus Voreinstellung ({tier})',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher wird ohne sie gerendert.',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      foliage: 'Laubdichte', detail: 'Oberflächendetails', particles: 'Glühwürmchen & Pollen', wind: 'Wind in den Blättern',
    },
    tiers: {
      off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      sparse: 'Spärlich', normal: 'Normal', dense: 'Dicht', plain: 'Einfach', detailed: 'Detailliert',
    },
    words: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'AO', fullAo: 'volle AO', bloom: 'Bloom', noAA: 'keine Kantenglättung' },
  },
  'fr-FR': FR,
  'fr-CA': { ...FR, auto: 'Auto (détecté: {tier})' },
  'pt-BR': {
    graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automático (detectado: {tier})', renderScale: 'Escala de renderização',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros', fromPreset: 'Do predefinido ({tier})',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
    presets: { low: 'Baixo', balanced: 'Equilibrado', high: 'Alto', ultra: 'Ultra' },
    cats: {
      shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de serrilhado',
      foliage: 'Densidade da folhagem', detail: 'Detalhe das superfícies', particles: 'Vaga-lumes e pólen', wind: 'Balanço do vento',
    },
    tiers: {
      off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      sparse: 'Esparsa', normal: 'Normal', dense: 'Densa', plain: 'Simples', detailed: 'Detalhado',
    },
    words: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'OA', fullAo: 'OA completa', bloom: 'brilho', noAA: 'sem suavização' },
  },
  'it-IT': {
    graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', renderScale: 'Scala di rendering',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi', fromPreset: 'Da preimpostazione ({tier})',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo, quindi il gioco viene mostrato senza.',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Anti-aliasing',
      foliage: 'Densità del fogliame', detail: 'Dettaglio superfici', particles: 'Lucciole e polline', wind: 'Oscillazione al vento',
    },
    tiers: {
      off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      sparse: 'Rado', normal: 'Normale', dense: 'Denso', plain: 'Semplice', detailed: 'Dettagliato',
    },
    words: { noShadows: 'nessuna ombra', shadows: 'ombre {n}²', ao: 'AO', fullAo: 'AO completa', bloom: 'bagliore', noAA: 'nessun AA' },
  },
};

/** Pick the panel locale: exact match, then language family, then en-US. */
export function pickLocale(lang) {
  const l = String(lang || 'en-US');
  if (STRINGS[l]) return l;
  const base = l.split('-')[0].toLowerCase();
  const family = { en: /GB|AU|NZ|IE|IN|ZA/i.test(l) ? 'en-GB' : 'en-US', es: 'es-419', de: 'de-DE', fr: /CA/i.test(l) ? 'fr-CA' : 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
  return family[base] || 'en-US';
}

const $ = (id) => document.getElementById(id);

/**
 * Bind the Graphics section. `settings.graphics.gfx` is the saved model;
 * `onChange()` persists + applies it; `getInfo()` returns the renderer's
 * graphicsInfo() (or null without WebGL).
 */
export function bindGraphics(settings, onChange, getInfo) {
  const L = STRINGS[pickLocale(globalThis.navigator && navigator.language)];
  if (!settings.graphics.gfx || typeof settings.graphics.gfx !== 'object') settings.graphics.gfx = { preset: 'auto' };
  const saved = () => settings.graphics.gfx;
  const detected = () => (getInfo() || {}).detected || 'low';

  $('gfx-legend').textContent = L.graphics;
  $('gfx-preset-label').textContent = L.quality;
  $('gfx-scale-label').textContent = L.renderScale;
  $('gfx-adaptive-label').textContent = L.adaptive;
  $('gfx-fps-label').textContent = L.showFps;

  const presetSel = $('gfx-preset');
  const scale = $('gfx-scale');
  const scaleVal = $('gfx-scale-val');
  const adaptive = $('gfx-adaptive');
  const fps = $('gfx-fps');
  const cats = $('gfx-cats');

  // one select per effect category
  cats.textContent = '';
  const catSel = {};
  for (const cat of Object.keys(CATEGORIES)) {
    const label = document.createElement('label');
    label.htmlFor = 'gfx-' + cat;
    label.textContent = L.cats[cat];
    const sel = document.createElement('select');
    sel.id = 'gfx-' + cat;
    sel.dataset.gfxCat = cat;
    sel.addEventListener('change', () => {
      const s = saved();
      if (sel.value) s[cat] = sel.value; else delete s[cat];
      commit();
    });
    cats.append(label, sel);
    catSel[cat] = sel;
  }

  presetSel.addEventListener('change', () => {
    const s = saved();
    const next = applyPreset(s, presetSel.value);
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, next);
    commit();
  });
  scale.addEventListener('input', () => { scaleVal.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => { saved().render_scale = Number(scale.value) / 100; commit(); });
  adaptive.addEventListener('change', () => { saved().adaptive = adaptive.checked; commit(); });
  fps.addEventListener('change', () => { saved().show_fps = fps.checked; commit(); });

  function commit() {
    onChange(settings);
    refresh();
  }

  function refresh() {
    const s = saved();
    const det = detected();
    const r = resolve(s, det);
    presetSel.textContent = '';
    const opts = [['auto', L.auto.replace('{tier}', L.presets[det])], ...PRESETS.map((p) => [p, L.presets[p]])];
    for (const [v, text] of opts) presetSel.append(new Option(text, v));
    presetSel.value = PRESETS.includes(s.preset) ? s.preset : 'auto';
    const pct = Math.round((Number(s.render_scale) || 1) * 100);
    scale.value = String(Math.min(200, Math.max(50, pct)));
    scaleVal.textContent = scale.value + '%';
    adaptive.checked = s.adaptive !== false;
    fps.checked = !!s.show_fps;
    for (const [cat, sel] of Object.entries(catSel)) {
      sel.textContent = '';
      sel.append(new Option(L.fromPreset.replace('{tier}', L.tiers[presetTier(r.preset, cat)]), ''));
      for (const t of CATEGORIES[cat]) sel.append(new Option(L.tiers[t], t));
      sel.value = CATEGORIES[cat].includes(s[cat]) ? s[cat] : '';
    }
    refreshSummary();
  }

  function refreshSummary() {
    const info = getInfo();
    const sum = $('gfx-summary');
    const note = $('gfx-note');
    if (!info) { sum.textContent = ''; note.hidden = true; return; }
    sum.textContent = `${info.gpu} · ${describe(info.resolved, info.pixels, L.words)}`;
    note.textContent = L.postFailed;
    note.hidden = !info.postFailed;
  }

  refresh();
  // keep the summary (pixel size, post status) fresh while the panel is open
  setInterval(() => {
    const scr = $('screen-settings');
    if (scr && scr.classList.contains('active')) refreshSummary();
  }, 1000);
  return { refresh };
}
