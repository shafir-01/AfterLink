export { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react';

/** Settles without overshoot: state changes should feel certain. */
export const settle = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 } as const;
export const fade = { duration: 0.24, ease: [0.22, 1, 0.36, 1] } as const;
export const slow = { duration: 0.48, ease: [0.22, 1, 0.36, 1] } as const;
