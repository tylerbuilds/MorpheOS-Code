// MorpheOS Code — ANSI colour theme
// Zeus palette: deep navy, gold, clean terminal

const CSI = "\x1b[";

export const colours = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,

  // Primary palette
  navy: `${CSI}38;5;19m`,       // Deep navy blue
  gold: `${CSI}38;5;178m`,       // Warm gold
  white: `${CSI}38;5;255m`,      // Near-white
  grey: `${CSI}38;5;243m`,       // Medium grey
  darkGrey: `${CSI}38;5;238m`,   // Dark grey

  // Semantic
  green: `${CSI}38;5;78m`,       // Success
  red: `${CSI}38;5;203m`,        // Error/warning
  amber: `${CSI}38;5;214m`,      // Caution
  cyan: `${CSI}38;5;81m`,        // Info / tool names
  blue: `${CSI}38;5;75m`,        // Links / highlights

  // Backgrounds
  bgNavy: `${CSI}48;5;19m`,
  bgDark: `${CSI}48;5;234m`,
};

export function paint(text: string, colour: string): string {
  return `${colour}${text}${colours.reset}`;
}

export function bold(text: string): string { return paint(text, colours.bold); }
export function dim(text: string): string { return paint(text, colours.dim); }
export function navy(text: string): string { return paint(text, colours.navy); }
export function gold(text: string): string { return paint(text, colours.gold); }
export function grey(text: string): string { return paint(text, colours.grey); }
export function green(text: string): string { return paint(text, colours.green); }
export function red(text: string): string { return paint(text, colours.red); }
export function cyan(text: string): string { return paint(text, colours.cyan); }
export function blue(text: string): string { return paint(text, colours.blue); }
export function amber(text: string): string { return paint(text, colours.amber); }

export function divider(width: number = 60): string {
  return grey("─".repeat(width));
}

export function section(title: string): string {
  return `\n${bold(navy(title))}\n${divider()}`;
}

export const tick = green("✓");
export const cross = red("✗");
export const spinner = amber("●");

export const zeusMOTD = `
${bold(gold(" ⚡ MorpheOS Code"))} ${dim("— Captain Zeus at the helm")}

${grey("Commands:")} /help  /model  /cost  /list  /exit
${grey("Powered by DeepSeek V4 · British English · Ship metaphors encouraged")}
`;
