import type { ComponentPropsWithRef, ReactNode } from 'react';
import { motion } from './motion';

type ButtonProps = Omit<ComponentPropsWithRef<typeof motion.button>, 'children'> & {
  variant?: 'primary' | 'secondary' | 'quiet';
  size?: 'medium' | 'large';
  block?: boolean;
  children?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'medium', block, className, type = 'button', ...rest }: ButtonProps) {
  const classes = ['al-button', `al-button--${variant}`, size === 'large' && 'al-button--large', block && 'al-button--block', className];
  return <motion.button type={type} whileTap={rest.disabled ? undefined : { scale: 0.97 }} className={classes.filter(Boolean).join(' ')} {...rest} />;
}
