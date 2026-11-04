import { createContext, useContext } from "react";

export type ToastMessage = { text: string; link?: { to: string; label: string } };
export type ShowToast = (toast: ToastMessage | null) => void;

/** Lives apart from ToastProvider so hooks and components can toast without importing its markup. */
export const ToastContext = createContext<ShowToast>(() => {});
export const useToast = () => useContext(ToastContext);
