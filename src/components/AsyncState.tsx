/**
 * Every screen that talks to the network renders through one of these, so no
 * screen can accidentally ship without an error, empty or loading state.
 */
import type { ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Text } from '@astryxdesign/core/Text';
import { ApiError } from '@/lib/errors';
import { BACKEND_NOT_CONFIGURED } from '@/lib/backend';

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <Section padding={4}>
      <VStack gap={3}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={64} />
        ))}
      </VStack>
    </Section>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const message = apiError?.friendly ?? (error as Error)?.message ?? 'Неизвестная ошибка.';

  return (
    <Section padding={4}>
      <VStack gap={3}>
        <Banner
          status="error"
          title="Не удалось загрузить"
          description={message}
        />
        {apiError?.code === 'BACKEND_NOT_CONFIGURED' ? (
          <Text type="supporting" as="p">
            {BACKEND_NOT_CONFIGURED}
          </Text>
        ) : null}
        {onRetry ? <Button label="Повторить" variant="secondary" onClick={onRetry} /> : null}
      </VStack>
    </Section>
  );
}

export function Empty({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <Section padding={4}>
      <EmptyState title={title} description={description ?? ''} />
    </Section>
  );
}

/** Renders exactly one of: loading → error → empty → content. */
export function AsyncState({
  isLoading,
  error,
  isEmpty,
  emptyTitle,
  emptyDescription,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyTitle?: string | undefined;
  emptyDescription?: string | undefined;
  onRetry?: (() => void) | undefined;
  children: ReactNode;
}) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isEmpty) {
    return <Empty title={emptyTitle ?? 'Пока пусто'} description={emptyDescription} />;
  }
  return <>{children}</>;
}
