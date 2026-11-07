import type { ComponentPropsWithoutRef, CSSProperties, ElementType } from 'react';

export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

type StackProps<T extends ElementType> = {
  as?: T;
  direction?: 'column' | 'row';
  gap?: Space;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  wrap?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'as'>;

export function Stack<T extends ElementType = 'div'>({ as, direction = 'column', gap = 4, align, justify, wrap, className, style, ...rest }: StackProps<T>) {
  const Element: ElementType = as ?? 'div';
  return (
    <Element
      className={className ? `al-stack ${className}` : 'al-stack'}
      style={{
        flexDirection: direction,
        gap: `var(--space-${gap})`,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : undefined,
        ...style,
      }}
      {...rest}
    />
  );
}
