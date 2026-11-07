import type { ComponentPropsWithoutRef, ElementType } from 'react';

export type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'label' | 'caption' | 'mono';
export type TextTone = 'default' | 'muted' | 'accent' | 'ok' | 'warn' | 'stop';

const DEFAULT_ELEMENT: Record<TextVariant, ElementType> = {
  display: 'h1',
  title: 'h2',
  heading: 'h3',
  body: 'p',
  label: 'span',
  caption: 'span',
  mono: 'span',
};

type TextProps<T extends ElementType> = {
  as?: T;
  variant?: TextVariant;
  tone?: TextTone;
  tabular?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'as'>;

export function Text<T extends ElementType = 'p'>({ as, variant = 'body', tone = 'default', tabular, className, ...rest }: TextProps<T>) {
  const Element: ElementType = as ?? DEFAULT_ELEMENT[variant];
  const classes = ['al-text', `al-text--${variant}`, tone !== 'default' && `al-tone--${tone}`, tabular && 'al-tabular', className];
  return <Element className={classes.filter(Boolean).join(' ')} {...rest} />;
}
