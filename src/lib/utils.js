// shadcn-style className helper.
// In a full shadcn + Tailwind setup this wraps clsx + tailwind-merge.
// This project ships without Tailwind, so we keep a zero-dependency join
// that still lets `@/components/ui` components merge passthrough classes.
export function cn(...inputs) {
  return inputs
    .flat(Infinity)
    .filter(Boolean)
    .join(" ");
}
