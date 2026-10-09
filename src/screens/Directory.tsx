/**
 * `/` — the list of studios built into this deployment.
 *
 * It reads the build-generated `tenants.json` rather than the database, because
 * this screen is the one place that must work before a studio is chosen and
 * before any tenant context exists. Runtime studio data still comes from the
 * database.
 */
import { useQuery } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Card } from '@astryxdesign/core/Card';
import { Link } from '@astryxdesign/core/Link';
import { Badge } from '@astryxdesign/core/Badge';
import { AsyncState } from '@/components/AsyncState';

interface DirectoryEntry {
  slug: string;
  name: string;
  tagline: string | null;
  accentColor: string;
  timezone: string;
  basePath: string;
  heroUrl: string | null;
  logoUrl: string | null;
  status: 'preview' | 'live' | 'suspended';
}

async function fetchDirectory(): Promise<DirectoryEntry[]> {
  const response = await fetch('/tenants.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(
      'Каталог студий не найден. Соберите приложение командой `npm run build` — файл public/tenants.json создаётся на этапе tenant:publish.',
    );
  }
  return (await response.json()) as DirectoryEntry[];
}

export function Directory() {
  const query = useQuery({
    queryKey: ['tenant-directory'],
    queryFn: fetchDirectory,
    staleTime: 300_000,
  });

  const studios = query.data ?? [];

  return (
    <Section padding={4}>
      <VStack gap={5}>
        <VStack gap={1}>
          <Heading level={1}>Онлайн-запись</Heading>
          <Text type="supporting" as="p">
            Выберите студию. Запись занимает меньше минуты и не требует регистрации.
          </Text>
        </VStack>

        <AsyncState
          isLoading={query.isLoading}
          error={query.error}
          isEmpty={studios.length === 0}
          emptyTitle="Студий пока нет"
          emptyDescription="Добавьте business.json и выполните tenant:publish."
          onRetry={() => {
            void query.refetch();
          }}
        >
          <VStack gap={3}>
            {studios.map((studio) => (
              <Card key={studio.slug}>
                <VStack gap={2}>
                  <VStack gap={1}>
                    <Heading level={2}>{studio.name}</Heading>
                    {studio.tagline ? (
                      <Text type="supporting" as="p">
                        {studio.tagline}
                      </Text>
                    ) : null}
                  </VStack>
                  <Link href={studio.basePath}>Открыть запись</Link>
                  <Badge label={studio.status === 'live' ? 'Работает' : 'Демо-режим'} />
                </VStack>
              </Card>
            ))}
          </VStack>
        </AsyncState>
      </VStack>
    </Section>
  );
}
