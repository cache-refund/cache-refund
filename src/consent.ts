export function parseConfirmation(answer: string, defaultYes: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return defaultYes;
}
