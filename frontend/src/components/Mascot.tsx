"use client";

import React, { useId, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

export type MascotMood =
  | "normal"
  | "hello"
  | "curious"
  | "searching"
  | "writing"
  | "thinking"
  | "celebrating"
  | "sad";

interface MascotProps {
  size?: number;
  thinking?: boolean;
  running?: boolean;
  direction?: "right" | "left";
  mood?: MascotMood;
  greetOnHover?: boolean;
  speech?: string | null;
  className?: string;
}

/**
 * Owly — Animated SVG companion mascot supporting idle, hello/wave, curious,
 * searching, writing, thinking, directional running, celebrating, and sad states.
 */
export const Mascot: React.FC<MascotProps> = ({
  size = 32,
  thinking = false,
  running = false,
  direction = "right",
  mood = "normal",
  greetOnHover = false,
  speech = null,
  className = "",
}) => {
  const uid = useId().replace(/:/g, "");
  const [hovered, setHovered] = useState(false);

  const bodyGradId = `pip-body-${uid}`;
  const bellyGradId = `pip-belly-${uid}`;
  const beakGradId = `pip-beak-${uid}`;
  const wingGradId = `pip-wing-${uid}`;

  const effectiveMood: MascotMood =
    greetOnHover && hovered && !running && mood !== "writing" && mood !== "sad"
      ? "hello"
      : mood === "normal" && thinking
        ? "thinking"
        : mood;

  const isWaving = effectiveMood === "hello";
  const isWriting = !running && effectiveMood === "writing";
  const isSearching = !running && effectiveMood === "searching";
  const isThinking = !running && effectiveMood === "thinking";
  const isCelebrating = !running && effectiveMood === "celebrating";
  const isCurious = !running && effectiveMood === "curious";
  const isSad = !running && effectiveMood === "sad";

  const bodyAnimate = running
    ? {
        y: [0, -4.5, 0, -4.5, 0],
        scaleY: [0.95, 1.06, 0.95, 1.06, 0.95],
        scaleX: [1.04, 0.97, 1.04, 0.97, 1.04],
        rotate: direction === "left" ? -11 : 11,
      }
    : isWaving
      ? {
          y: [0, -4, 0, -3, 0],
          rotate: [0, -4, 4, -3, 0],
          scale: [1, 1.05, 1, 1.04, 1],
        }
      : isWriting
        ? {
            y: [0, -1.6, 0, -1.2, 0],
            rotate: [5, 7.5, 5.5, 7, 5],
            scaleY: [1, 0.985, 1, 0.99, 1],
          }
        : isSearching
          ? {
              y: [0, -2.5, 0],
              rotate: [-4, 5, -4],
            }
          : isCelebrating
            ? {
                y: [0, -5, 0, -3.5, 0],
                scaleY: [1, 1.07, 0.97, 1.05, 1],
                rotate: [0, -5, 5, -3, 0],
              }
            : isCurious
              ? {
                  y: [0, -2.2, 0],
                  rotate: [0, -6, -4],
                  scale: 1.03,
                }
              : isSad
                ? {
                    y: [0, 1.8, 0],
                    rotate: [-3, -5, -3],
                    scale: 0.97,
                  }
                : isThinking
                  ? {
                      y: [0, -3.8, 0, -2.2, 0],
                      rotate: [0, -5, 5, -3, 0],
                      scale: [1, 1.04, 0.98, 1.03, 1],
                    }
                  : {
                      y: [0, -1.8, 0],
                      scaleY: [1, 1.02, 1],
                      rotate: 0,
                    };

  const bodyTransition = running
    ? { repeat: Infinity, duration: 0.36, ease: "easeInOut" as const }
    : isWaving
      ? { repeat: Infinity, duration: 1.5, ease: "easeInOut" as const }
      : isWriting
        ? { repeat: Infinity, duration: 0.9, ease: "easeInOut" as const }
        : isSearching
          ? { repeat: Infinity, duration: 1.8, ease: "easeInOut" as const }
          : isCelebrating
            ? { repeat: Infinity, duration: 1.35, ease: "easeInOut" as const }
            : isCurious
              ? { repeat: Infinity, duration: 2.2, ease: "easeInOut" as const }
              : isSad
                ? { repeat: Infinity, duration: 2.6, ease: "easeInOut" as const }
                : isThinking
                  ? { repeat: Infinity, duration: 1.35, ease: "easeInOut" as const }
                  : { repeat: Infinity, duration: 3.2, ease: "easeInOut" as const };

  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <AnimatePresence>
        {speech && (
          <motion.div
            key={speech}
            initial={{ opacity: 0, y: 6, scale: 0.88 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.88 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
            className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-[#DE7356] to-[#C15F3C] px-2.5 py-0.5 text-[10px] font-semibold text-white shadow-lg"
          >
            {speech}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 72 72"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="select-none overflow-visible"
        whileHover={{ scale: 1.09, transition: { duration: 0.25 } }}
        whileTap={{ scale: 0.93 }}
        animate={bodyAnimate}
        transition={bodyTransition}
      >
        <defs>
          <linearGradient id={bodyGradId} x1="16" y1="12" x2="56" y2="62" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#EB8A6D" />
            <stop offset="52%" stopColor="#DE7356" />
            <stop offset="100%" stopColor="#C15F3C" />
          </linearGradient>
          <linearGradient id={bellyGradId} x1="36" y1="40" x2="36" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FAF8F4" />
            <stop offset="100%" stopColor="#EDE6DC" />
          </linearGradient>
          <linearGradient id={beakGradId} x1="36" y1="35" x2="36" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FCD34D" />
            <stop offset="100%" stopColor="#F59E0B" />
          </linearGradient>
          <linearGradient id={wingGradId} x1="12" y1="32" x2="22" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#D66B4D" />
            <stop offset="100%" stopColor="#A94B2B" />
          </linearGradient>
        </defs>

        {/* Character group flips cleanly left/right when running */}
        <g transform={running && direction === "left" ? "translate(72, 0) scale(-1, 1)" : undefined}>
          {/* Trailing dust puffs & speed lines when running */}
          {running && (
            <g>
              <motion.circle
                cx="16"
                cy="61"
                r="2.6"
                fill="#FAF8F4"
                animate={{ x: [0, -14], y: [0, -3], scale: [0.55, 1.25], opacity: [0.65, 0] }}
                transition={{ repeat: Infinity, duration: 0.42, ease: "easeOut" }}
              />
              <motion.circle
                cx="12"
                cy="58"
                r="2"
                fill="#DE7356"
                animate={{ x: [0, -16], y: [0, -4], scale: [0.5, 1.15], opacity: [0.6, 0] }}
                transition={{ repeat: Infinity, duration: 0.42, delay: 0.18, ease: "easeOut" }}
              />
              <motion.line
                x1="6"
                y1="30"
                x2="13"
                y2="30"
                stroke="#FCD34D"
                strokeWidth="1.8"
                strokeLinecap="round"
                animate={{ x: [0, -8], opacity: [0.85, 0] }}
                transition={{ repeat: Infinity, duration: 0.35, ease: "easeOut" }}
              />
              <motion.line
                x1="3"
                y1="38"
                x2="11"
                y2="38"
                stroke="#FAF8F4"
                strokeWidth="1.6"
                strokeLinecap="round"
                animate={{ x: [0, -9], opacity: [0.7, 0] }}
                transition={{ repeat: Infinity, duration: 0.35, delay: 0.14, ease: "easeOut" }}
              />
            </g>
          )}

          {/* Hello greeting sparkles */}
          {isWaving && !running && (
            <g>
              <motion.path
                d="M11 16 L12.4 12.8 L13.8 16 L17 17.4 L13.8 18.8 L12.4 22 L11 18.8 L7.8 17.4 Z"
                fill="#FCD34D"
                animate={{ scale: [0.4, 1.2, 0.4], rotate: [0, 35, 0], opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
                style={{ transformOrigin: "12.4px 17.4px" }}
              />
              <motion.path
                d="M61 20 C64 22 65 26 63 30"
                stroke="#FCD34D"
                strokeWidth="1.7"
                strokeLinecap="round"
                animate={{ opacity: [0, 0.9, 0], pathLength: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 0.75, ease: "easeInOut" }}
              />
              <motion.path
                d="M64 17 C67.5 19.5 69 24.5 66.5 29.5"
                stroke="#F4A892"
                strokeWidth="1.5"
                strokeLinecap="round"
                animate={{ opacity: [0, 0.85, 0] }}
                transition={{ repeat: Infinity, duration: 0.75, delay: 0.12, ease: "easeInOut" }}
              />
            </g>
          )}

          {/* Thinking floating dots */}
          {isThinking && (
            <g>
              <motion.circle
                cx="53"
                cy="17"
                r="1.8"
                fill="#F4F3EE"
                animate={{ y: [0, -3, 0], opacity: [0.4, 0.95, 0.4] }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
              />
              <motion.circle
                cx="57.5"
                cy="11.5"
                r="2.4"
                fill="#FCD34D"
                animate={{ y: [0, -3.5, 0], opacity: [0.45, 1, 0.45] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.25, ease: "easeInOut" }}
              />
              <motion.circle
                cx="62.5"
                cy="5.5"
                r="3.2"
                fill="#DE7356"
                animate={{ y: [0, -4, 0], scale: [0.9, 1.12, 0.9], opacity: [0.55, 1, 0.55] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.45, ease: "easeInOut" }}
              />
            </g>
          )}

          {/* Celebrating confetti sparkles */}
          {isCelebrating && (
            <g>
              <motion.path
                d="M14 14 L15.4 10.5 L16.8 14 L20.3 15.4 L16.8 16.8 L15.4 20.3 L14 16.8 L10.5 15.4 Z"
                fill="#FCD34D"
                animate={{ scale: [0.6, 1.25, 0.6], opacity: [0.4, 1, 0.4], y: [0, -5, 0] }}
                transition={{ repeat: Infinity, duration: 0.95, ease: "easeInOut" }}
                style={{ transformOrigin: "15.4px 15.4px" }}
              />
              <motion.path
                d="M57 12 L58.1 9.2 L59.2 12 L62 13.1 L59.2 14.2 L58.1 17 L57 14.2 L54.2 13.1 Z"
                fill="#34D399"
                animate={{ scale: [0.65, 1.25, 0.65], opacity: [0.4, 1, 0.4], y: [0, -4, 0] }}
                transition={{ repeat: Infinity, duration: 1.05, delay: 0.25, ease: "easeInOut" }}
                style={{ transformOrigin: "58.1px 13.1px" }}
              />
              <motion.circle
                cx="36"
                cy="6"
                r="2.2"
                fill="#FBBF24"
                animate={{ opacity: [0.3, 1, 0.3], y: [2, -4, 2], scale: [0.8, 1.3, 0.8] }}
                transition={{ repeat: Infinity, duration: 0.85, delay: 0.15 }}
                style={{ transformOrigin: "36px 6px" }}
              />
            </g>
          )}

          {/* Back/Left Foot with alternating stride */}
          <motion.g
            animate={
              running
                ? {
                    x: [-5.5, 0, 5.5, 1.5, -5.5],
                    y: [0, -5.5, -0.5, 1.5, 0],
                    rotate: [-22, 0, 18, 6, -22],
                  }
                : isCelebrating
                  ? { y: [0, -2.5, 0], rotate: [0, -10, 0] }
                  : { x: 0, y: 0, rotate: 0 }
            }
            transition={
              running
                ? { repeat: Infinity, duration: 0.36, ease: "linear" }
                : isCelebrating
                  ? { repeat: Infinity, duration: 0.7, ease: "easeInOut" }
                  : { duration: 0.2 }
            }
            style={{ transformOrigin: "27.5px 59px" }}
          >
            <ellipse cx="27.5" cy="61.5" rx="5" ry="3" fill="#D97706" />
            <circle cx="24.5" cy="62" r="1.7" fill="#F59E0B" />
            <circle cx="27.5" cy="62.5" r="1.7" fill="#F59E0B" />
          </motion.g>

          {/* Front/Right Foot (180° opposite phase stride) */}
          <motion.g
            animate={
              running
                ? {
                    x: [5.5, 1.5, -5.5, 0, 5.5],
                    y: [-0.5, 1.5, 0, -5.5, -0.5],
                    rotate: [18, 6, -22, 0, 18],
                  }
                : isCelebrating
                  ? { y: [0, -2.5, 0], rotate: [0, 10, 0] }
                  : { x: 0, y: 0, rotate: 0 }
            }
            transition={
              running
                ? { repeat: Infinity, duration: 0.36, ease: "linear" }
                : isCelebrating
                  ? { repeat: Infinity, duration: 0.7, delay: 0.15, ease: "easeInOut" }
                  : { duration: 0.2 }
            }
            style={{ transformOrigin: "44.5px 59px" }}
          >
            <ellipse cx="44.5" cy="61.5" rx="5" ry="3" fill="#F59E0B" />
            <circle cx="44.5" cy="62.5" r="1.7" fill="#FBBF24" />
            <circle cx="47.5" cy="62" r="1.7" fill="#FBBF24" />
          </motion.g>

          {/* Left wing */}
          <motion.path
            d="M15.5 34 C9.5 35.5 7.5 43.5 11.5 49.5 C13.5 52.5 17 51.5 18.5 47 Z"
            fill={`url(#${wingGradId})`}
            animate={
              running
                ? { rotate: [-28, 24, -28] }
                : isCelebrating
                  ? { rotate: [25, 48, 25] }
                  : isWaving
                    ? { rotate: [6, 18, 6] }
                    : isSad
                      ? { rotate: [-12, -16, -12] }
                      : isThinking
                        ? { rotate: [0, -18, 6, -14, 0] }
                        : { rotate: [0, -4, 0] }
            }
            transition={
              running
                ? { repeat: Infinity, duration: 0.36, ease: "easeInOut" }
                : isCelebrating
                  ? { repeat: Infinity, duration: 0.65, ease: "easeInOut" }
                  : isThinking
                    ? { repeat: Infinity, duration: 0.75, ease: "easeInOut" }
                    : { repeat: Infinity, duration: 2.2, ease: "easeInOut" }
            }
            style={{ transformOrigin: "17px 37px" }}
          />

          {/* Right wing (waves high for hello, holds pen while writing, cheers for celebrating) */}
          <motion.path
            d="M56.5 34 C62.5 35.5 64.5 43.5 60.5 49.5 C58.5 52.5 55 51.5 53.5 47 Z"
            fill={`url(#${wingGradId})`}
            animate={
              running
                ? { rotate: [28, -24, 28] }
                : isWaving
                  ? { rotate: [-75, -118, -68, -118, -75] }
                  : isWriting
                    ? { rotate: [-12, 8, -16, 6, -12] }
                    : isCelebrating
                      ? { rotate: [-28, -55, -28] }
                      : isSad
                        ? { rotate: [12, 16, 12] }
                        : isThinking
                          ? { rotate: [0, 18, -6, 14, 0] }
                          : { rotate: [0, 4, 0] }
            }
            transition={
              running
                ? { repeat: Infinity, duration: 0.36, ease: "easeInOut" }
                : isWaving
                  ? { repeat: Infinity, duration: 0.85, ease: "easeInOut" }
                  : isWriting
                    ? { repeat: Infinity, duration: 0.48, ease: "easeInOut" }
                    : isCelebrating
                      ? { repeat: Infinity, duration: 0.65, ease: "easeInOut" }
                      : isThinking
                        ? { repeat: Infinity, duration: 0.75, ease: "easeInOut" }
                        : { repeat: Infinity, duration: 2.2, ease: "easeInOut" }
            }
            style={{ transformOrigin: "55px 37px" }}
          />

          {/* Cute top feather sprout */}
          <motion.path
            d="M36 16 C35 11.5 38.5 8.5 41.5 10.5 C39.5 12.5 38 14 37.5 16 Z"
            fill="#EB8A6D"
            animate={{
              rotate: running ? [-14, 6, -14] : isWaving || isCelebrating ? [-12, 14, -12] : isThinking ? [-8, 10, -8] : [-2, 3, -2],
            }}
            transition={{ repeat: Infinity, duration: running ? 0.36 : isWaving ? 0.8 : isThinking ? 0.9 : 3.2, ease: "easeInOut" }}
            style={{ transformOrigin: "36.5px 15.5px" }}
          />

          {/* Cute rounded ear tufts */}
          <motion.path
            d="M19 23 C14.5 15 17.5 10.5 24 14.5 C26 15.8 26.8 18 26 20.5 Z"
            fill="#C15F3C"
            animate={{ rotate: running ? [-10, 4, -10] : isCurious ? [-10, -4, -10] : isThinking ? [0, -7, 2, 0] : [0, -2, 0] }}
            transition={{ repeat: Infinity, duration: running ? 0.36 : isThinking ? 1.1 : 3.5, ease: "easeInOut" }}
            style={{ transformOrigin: "23px 20px" }}
          />
          <motion.path
            d="M53 23 C57.5 15 54.5 10.5 48 14.5 C46 15.8 45.2 18 46 20.5 Z"
            fill="#C15F3C"
            animate={{ rotate: running ? [-8, 5, -8] : isCurious ? [10, 4, 10] : isThinking ? [0, 7, -2, 0] : [0, 2, 0] }}
            transition={{ repeat: Infinity, duration: running ? 0.36 : isThinking ? 1.1 : 3.5, ease: "easeInOut" }}
            style={{ transformOrigin: "49px 20px" }}
          />
          <path d="M19.8 20.2 C17.5 15.8 19.2 13.5 22.8 15.8" stroke="#F4A892" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M52.2 20.2 C54.5 15.8 52.8 13.5 49.2 15.8" stroke="#F4A892" strokeWidth="1.8" strokeLinecap="round" />

          {/* Plump chubby owl body */}
          <path
            d="M14.5 39 C14.5 22.5 23 15 36 15 C49 15 57.5 22.5 57.5 39 C57.5 53.5 48.8 61 36 61 C23.2 61 14.5 53.5 14.5 39 Z"
            fill={`url(#${bodyGradId})`}
          />

          {/* Soft glossy crown highlight */}
          <path
            d="M25 19.5 C30 17 42 17 47 19.5"
            stroke="#FFF8F3"
            strokeOpacity="0.4"
            strokeWidth="2.4"
            strokeLinecap="round"
          />

          {/* Warm cream belly patch */}
          <ellipse cx="36" cy="50.5" rx="13.5" ry="9.5" fill={`url(#${bellyGradId})`} />
          <path
            d="M29.5 48.5 Q31.5 51 33.5 48.5 M34 51.5 Q36 54 38 51.5 M38.5 48.5 Q40.5 51 42.5 48.5"
            stroke="#DE7356"
            strokeOpacity="0.45"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />

          {/* Warm cream eye mask */}
          <circle cx="27.5" cy="31.5" r="10.2" fill="#FAF7F2" />
          <circle cx="44.5" cy="31.5" r="10.2" fill="#FAF7F2" />
          <path d="M27.5 39.5 Q36 43.5 44.5 39.5 L42 32 L30 32 Z" fill="#FAF7F2" />

          {/* Rosy blushing cheeks */}
          <motion.ellipse
            cx="21.2"
            cy="37.8"
            rx="3.1"
            ry="1.8"
            fill="#FF8298"
            animate={{ opacity: isWaving || isCelebrating ? [0.7, 1, 0.7] : [0.55, 0.85, 0.55] }}
            transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
          />
          <motion.ellipse
            cx="50.8"
            cy="37.8"
            rx="3.1"
            ry="1.8"
            fill="#FF8298"
            animate={{ opacity: isWaving || isCelebrating ? [0.7, 1, 0.7] : [0.55, 0.85, 0.55] }}
            transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
          />

          {/* Expressive eyes: joyful crescents when celebrating, natural blink & gaze otherwise */}
          {isCelebrating ? (
            <g>
              <path d="M22.5 32.5 Q27.5 26.5 32.5 32.5" stroke="#1C1917" strokeWidth="2.8" strokeLinecap="round" fill="none" />
              <path d="M39.5 32.5 Q44.5 26.5 49.5 32.5" stroke="#1C1917" strokeWidth="2.8" strokeLinecap="round" fill="none" />
            </g>
          ) : (
            <motion.g
              animate={{ scaleY: [1, 1, 0.06, 1, 1] }}
              transition={{
                repeat: Infinity,
                duration: isWaving ? 2.8 : 4.2,
                times: [0, 0.9, 0.94, 0.98, 1],
                ease: "easeInOut",
              }}
              style={{ transformOrigin: "36px 31.5px" }}
            >
              <motion.g
                animate={
                  running
                    ? { x: 1.8, y: 0.2 }
                    : isWriting
                      ? { x: [1.6, 2.5, 1.4], y: [1.8, 2.2, 1.8] }
                      : isSearching
                        ? { x: [-2.2, 2.2, -2.2], y: [0.5, -0.5, 0.5] }
                        : isThinking
                          ? { x: [0, 1.3, 0, -1.3, 0], y: [0, -0.9, 0, -0.9, 0] }
                          : isCurious
                            ? { x: [0, 1.2, 0], y: -0.6 }
                            : { x: 0, y: 0 }
                }
                transition={
                  running
                    ? { duration: 0.15 }
                    : isWriting
                      ? { repeat: Infinity, duration: 0.65, ease: "easeInOut" }
                      : isSearching
                        ? { repeat: Infinity, duration: 1.5, ease: "easeInOut" }
                        : isThinking
                          ? { repeat: Infinity, duration: 1.6, ease: "easeInOut" }
                          : { duration: 0.25 }
                }
              >
                <circle cx="27.5" cy="31.5" r="5.5" fill="#1C1917" />
                <circle cx="25.6" cy="29.4" r="2.1" fill="#FFFFFF" />
                <circle cx="29.6" cy="33.4" r="0.95" fill="#FFFFFF" fillOpacity="0.9" />

                <circle cx="44.5" cy="31.5" r="5.5" fill="#1C1917" />
                <circle cx="42.6" cy="29.4" r="2.1" fill="#FFFFFF" />
                <circle cx="46.6" cy="33.4" r="0.95" fill="#FFFFFF" fillOpacity="0.9" />
              </motion.g>
            </motion.g>
          )}

          {/* Shimmering teardrop when sad */}
          {isSad && (
            <motion.path
              d="M21.5 34.5 C21.5 34.5 19.3 37.8 19.3 39.2 A2.2 2.2 0 1 0 23.7 39.2 C23.7 37.8 21.5 34.5 21.5 34.5 Z"
              fill="#38BDF8"
              animate={{ y: [0, 7, 11], opacity: [0.95, 0.75, 0] }}
              transition={{ repeat: Infinity, duration: 1.6, ease: "easeIn" }}
            />
          )}

          {/* Cute rounded golden beak */}
          <path
            d="M36 34.2 C38.6 34.2 39.8 36.2 38.6 38.2 C37.6 39.8 36.7 40.6 36 40.6 C35.3 40.6 34.4 39.8 33.4 38.2 C32.2 36.2 33.4 34.2 36 34.2 Z"
            fill={`url(#${beakGradId})`}
          />
          <ellipse cx="35.1" cy="35.6" rx="1" ry="0.55" fill="#FEF3C7" fillOpacity="0.75" />

          {/* Smile */}
          <path
            d={
              isSad
                ? "M33.2 42.6 Q36 40.6 38.8 42.6"
                : isCurious
                  ? "M33.5 41.8 Q36.2 42.6 38.6 41.1"
                  : "M33.2 41.3 Q36 43.6 38.8 41.3"
            }
            stroke="#8C3B22"
            strokeWidth="1.7"
            strokeLinecap="round"
            fill="none"
          />

          {/* Writing Animation: Glowing notepad & animated scribbling pen + ink sparks */}
          {isWriting && (
            <g>
              {/* Tiny glowing paper card */}
              <rect
                x="46"
                y="45"
                width="18"
                height="16"
                rx="2.5"
                fill="#FFFDF9"
                stroke="#DE7356"
                strokeWidth="1.3"
              />
              <motion.line
                x1="49"
                y1="49.5"
                x2="60.5"
                y2="49.5"
                stroke="#C15F3C"
                strokeWidth="1.4"
                strokeLinecap="round"
                animate={{ pathLength: [0.1, 1, 1], opacity: [0.4, 1, 1] }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeOut" }}
              />
              <motion.line
                x1="49"
                y1="53"
                x2="61"
                y2="53"
                stroke="#DE7356"
                strokeWidth="1.4"
                strokeLinecap="round"
                animate={{ pathLength: [0, 0.2, 1], opacity: [0.3, 0.8, 1] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.2, ease: "easeOut" }}
              />
              <motion.line
                x1="49"
                y1="56.5"
                x2="58"
                y2="56.5"
                stroke="#EA9D84"
                strokeWidth="1.4"
                strokeLinecap="round"
                animate={{ pathLength: [0, 0.1, 1], opacity: [0.3, 0.7, 1] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.4, ease: "easeOut" }}
              />
              {/* Animated stylus/pen */}
              <motion.g
                animate={{
                  x: [-2.5, 4.5, -1.5, 5, -2.5],
                  y: [-1.5, 1, 2.5, 0.5, -1.5],
                  rotate: [-16, 10, -14, 12, -16],
                }}
                transition={{ repeat: Infinity, duration: 0.75, ease: "easeInOut" }}
                style={{ transformOrigin: "58px 46px" }}
              >
                <rect
                  x="58.5"
                  y="32"
                  width="3.4"
                  height="14"
                  rx="1.2"
                  transform="rotate(24 58.5 32)"
                  fill="#FCD34D"
                  stroke="#B45309"
                  strokeWidth="0.9"
                />
                <polygon points="53,45 56.2,46.4 52.6,48.6" fill="#C15F3C" />
              </motion.g>
              {/* Floating writing sparkle */}
              <motion.circle
                cx="64"
                cy="41"
                r="1.6"
                fill="#FCD34D"
                animate={{ y: [0, -7], opacity: [0, 1, 0], scale: [0.6, 1.2, 0.5] }}
                transition={{ repeat: Infinity, duration: 0.9, ease: "easeOut" }}
              />
            </g>
          )}

          {/* Searching Animation: Orbiting magnifying glass */}
          {isSearching && (
            <motion.g
              animate={{
                x: [-4, 4, -2, 3, -4],
                y: [-2, 1.5, 3, -1, -2],
                rotate: [-10, 12, -6, 10, -10],
              }}
              transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
              style={{ transformOrigin: "54px 44px" }}
            >
              <circle
                cx="54"
                cy="42"
                r="7.2"
                fill="#38BDF8"
                fillOpacity="0.22"
                stroke="#FCD34D"
                strokeWidth="2.2"
              />
              <path d="M51 39.2 A4 4 0 0 1 55.8 38.6" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" />
              <line x1="59.3" y1="47.3" x2="64.5" y2="52.5" stroke="#B45309" strokeWidth="2.8" strokeLinecap="round" />
            </motion.g>
          )}
        </g>
      </motion.svg>
    </div>
  );
};
