import kemudiK from "@/assets/kemudi-k.png";
import { cn } from "@/lib/utils";

/** The Kemudi K in Jalur Gemilang colours (the app icon's mark, cut out of
 *  design/logo/kemudi-flag-source.png). Size it by height. */
export function LogoMark({ className }: { className?: string }) {
  return <img src={kemudiK} alt="" aria-hidden draggable={false} className={cn("h-3 w-auto flex-none select-none", className)} />;
}
