import React, { createContext, useContext } from "react";
import { motionText, type MotionLocale } from "./i18n";

export const MotionLocaleContext = createContext<MotionLocale>("ko");
export const useMotionText = () => {
  const locale = useContext(MotionLocaleContext);
  return (text: string) => motionText(text, locale);
};
