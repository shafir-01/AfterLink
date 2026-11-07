import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { Stack } from './Stack';
import { Text } from './Text';

type Loader = () => Promise<unknown>;

export function Unavailable({ title }: { title: string }) {
  return (
    <main className="al-center">
      <Stack gap={2} align="center">
        <Text variant="title" as="h1">
          {title}
        </Text>
        <Text tone="muted">Not available in this build.</Text>
      </Stack>
    </main>
  );
}

/** Finds the first glob match whose file name, without extension, appears in `names`. */
function pick(modules: Record<string, Loader>, names: string[]): Loader | undefined {
  const paths = Object.keys(modules);
  for (const name of names) {
    const path = paths.find((candidate) => candidate.replace(/^.*\//, '').replace(/\.tsx?$/, '') === name);
    if (path) return modules[path];
  }
  return undefined;
}

/**
 * Loads an optional view found by import.meta.glob. A view that is absent or fails
 * to load renders a fallback, so one missing module never takes the app down.
 */
export function guardedView<P extends object>(modules: Record<string, Loader>, names: string[], exportName: string, title: string) {
  const load = pick(modules, names);
  const fallback = () => <Unavailable title={title} />;
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    if (!load) return { default: fallback };
    try {
      const mod = (await load()) as Record<string, unknown>;
      const view = (mod.default ?? mod[exportName]) as ComponentType<P> | undefined;
      return { default: view ?? fallback };
    } catch (error) {
      console.error(`Could not load ${title}`, error);
      return { default: fallback };
    }
  });
}

export class ViewBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(error);
  }

  override render() {
    return this.state.failed ? <Unavailable title={this.props.title} /> : this.props.children;
  }
}
