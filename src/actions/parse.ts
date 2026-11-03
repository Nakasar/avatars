import { resolveAction, type ActionCode } from './vocabulary';

/** Un code d'action placé dans un texte, à la position (dans le texte nettoyé) où il apparaît. */
export interface ActionCue {
  code: ActionCode;
  /** Position dans le texte nettoyé (0 = début). */
  offset: number;
}

export interface ParsedText {
  /** Le texte sans aucun code, prêt à être affiché ou prononcé. */
  text: string;
  cues: ActionCue[];
  /** Codes entre crochets inconnus : retirés du texte, mais ignorés. */
  unknown: string[];
}

/**
 * `[[ACTION.X.Y]]`, `[[ ACTION.X.Y:param ]]`… L'agent pouvant se tromper de casse ou
 * glisser des espaces, la reconnaissance est tolérante. Les codes sont aussi retirés
 * s'ils sont échappés en Markdown (`\[\[ACTION…\]\]`).
 */
const CODE = /\\?\[\\?\[\s*(ACTION\b[^\]\n]{0,120}?)\s*\\?\]\\?\]/gi;
/** Début de code pas encore complet, en fin de texte pendant le streaming. */
const PARTIAL = /\\?\[(?:\\?\[(?:\s*[A-Z][^\]\n]{0,120}(?:\\?\])?)?)?$/i;

/**
 * Sépare un texte de ses codes d'action.
 *
 * Pendant le streaming (`final = false`), un code coupé en fin de texte (« [[ACTION.EMO »)
 * est retenu : il n'est ni affiché ni prononcé tant qu'il n'est pas complet.
 */
export function parseActions(input: string, final = true): ParsedText {
  let source = input;
  if (!final) {
    const tail = PARTIAL.exec(source);
    if (tail && couldBeCode(tail[0])) source = source.slice(0, tail.index);
  }
  const cues: ActionCue[] = [];
  const unknown: string[] = [];
  let text = '';
  let last = 0;
  CODE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = CODE.exec(source)); ) {
    text += source.slice(last, m.index);
    last = m.index + m[0].length;
    const code = resolveAction(m[1].trim(), m[0]);
    if (code) cues.push({ code, offset: text.length });
    else unknown.push(m[0]);
  }
  text += source.slice(last);
  // Un code retiré laisse souvent un double espace (« Bon [[…]] alors ») ou un espace en tête.
  const tidy = tidySpaces(text, cues);
  return { text: tidy.text, cues: tidy.cues, unknown };
}

/** Le texte, sans les codes : pour l'affichage. */
export function stripActions(input: string, final = true): string {
  return parseActions(input, final).text;
}

/**
 * Coupe un texte en streaming juste avant un éventuel code incomplet, pour que le
 * découpage en phrases ne prononce pas la moitié d'un code.
 */
export function safeStreamingText(input: string): string {
  const tail = PARTIAL.exec(input);
  return tail && couldBeCode(tail[0]) ? input.slice(0, tail.index) : input;
}

function couldBeCode(tail: string) {
  const letters = tail.replace(/[\\[\s]/g, '').toUpperCase();
  return 'ACTION'.startsWith(letters.slice(0, 6)) && (letters.length <= 6 || letters.startsWith('ACTION'));
}

function tidySpaces(text: string, cues: ActionCue[]) {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length;
    const ch = text[i];
    if (/[ \t]/.test(ch) && (out.length === 0 || /[ \t\n]$/.test(out))) continue;
    if (/[.,…]/.test(ch) && /[ \t]$/.test(out)) {
      // « fâché [[…]]. » → « fâché. »
      out = out.slice(0, -1);
      for (let j = i; j >= 0 && map[j] > out.length; j--) map[j] = out.length;
    }
    out += ch;
  }
  map[text.length] = out.length;
  const trimmed = out.replace(/[ \t]+$/, '');
  return {
    text: trimmed,
    cues: cues.map((c) => ({ ...c, offset: Math.min(map[c.offset], trimmed.length) })),
  };
}
