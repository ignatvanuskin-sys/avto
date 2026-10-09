/**
 * The studio's front screen: services, working hours and the entry point into
 * the booking flow. Everything here comes from the database.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { AsyncState } from '@/components/AsyncState';
import { BookingFlow } from '@/components/BookingFlow';
import { fetchSlots } from '@/lib/api';
import { backendConfig } from '@/lib/backend';
import { formatDuration, formatMoney, todayInZone, addDaysToIsoDate } from '@/lib/format';
import { useTenant } from '@/tenant/TenantProvider';
import type { PublicService } from '@shared/tenant-types';

function ServiceCard({
  service,
  slug,
  timezone,
  onChoose,
}: {
  service: PublicService;
  slug: string;
  timezone: string;
  onChoose: (service: PublicService) => void;
}) {
  const from = todayInZone(timezone);
  const to = addDaysToIsoDate(from, 7);

  const slots = useQuery({
    queryKey: ['slots', slug, service.key, from, to],
    enabled: backendConfig.isConfigured && slug.length > 0,
    staleTime: 15_000,
    queryFn: () => fetchSlots(slug, service.key, from, to),
  });

  const nextSlot = slots.data?.[0];

  return (
    <Card>
      <VStack gap={3}>
        <VStack gap={1}>
          <HStack gap={2} align="center" justify="between">
            <Heading level={3}>{service.name}</Heading>
            <Badge label={formatMoney(service.priceCents, service.currency)} />
          </HStack>
          {service.description ? (
            <Text type="supporting" as="p">
              {service.description}
            </Text>
          ) : null}
        </VStack>

        <HStack gap={2} align="center">
          <Text type="supporting">{formatDuration(service.durationMin)}</Text>
          {service.spansDays ? <Badge label="Несколько дней" /> : null}
        </HStack>

        {slots.isError ? (
          <Banner
            status="warning"
            title="Свободные окна не загрузились"
            description="Можно всё равно начать запись — окна подтянутся на следующем шаге."
          />
        ) : null}

        {!slots.isLoading && !slots.isError && !nextSlot ? (
          <Text type="supporting">На ближайшую неделю свободных окон нет.</Text>
        ) : null}

        {nextSlot ? (
          <Text type="supporting">
            Ближайшее окно: {new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(nextSlot.slot_start))}
          </Text>
        ) : null}

        <Button
          label="Записаться"
          variant="primary"
          width="100%"
          onClick={() => onChoose(service)}
        />
      </VStack>
    </Card>
  );
}

export function StudioHome() {
  const tenant = useTenant();
  const [activeService, setActiveService] = useState<PublicService | null>(null);
  const [isFlowOpen, setFlowOpen] = useState(false);
  const slug = tenant.boot?.slug ?? '';

  const profile = tenant.profile;

  if (!backendConfig.isConfigured) {
    return (
      <Section padding={4}>
        <Banner
          status="warning"
          title="Студия не подключена к базе данных"
          description="Задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY, затем пересоберите приложение. Данные студии читаются из базы, а не из вёрстки."
        />
      </Section>
    );
  }

  return (
    <>
      <Section padding={4}>
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>{profile?.name ?? tenant.boot?.name ?? 'Студия'}</Heading>
            {profile?.tagline ? <Text type="supporting" as="p">{profile.tagline}</Text> : null}
            {profile?.status === 'preview' ? (
              <Banner
                status="info"
                title="Демо-режим"
                description="Это предпросмотр студии. Реальные уведомления не отправляются."
              />
            ) : null}
          </VStack>

          <AsyncState
            isLoading={tenant.isLoading}
            error={tenant.error}
            isEmpty={Boolean(profile) && (profile?.services.length ?? 0) === 0}
            emptyTitle="Услуги ещё не опубликованы"
            emptyDescription="Опубликуйте конфигурацию студии: npm run tenant:publish"
            onRetry={tenant.refetch}
          >
            <VStack gap={4}>
              <Heading level={2}>Услуги</Heading>
              <VStack gap={3}>
                {(profile?.services ?? []).map((service) => (
                  <ServiceCard
                    key={service.key}
                    service={service}
                    slug={slug}
                    timezone={profile?.timezone ?? tenant.boot?.timezone ?? 'UTC'}
                    onChoose={(chosen) => {
                      setActiveService(chosen);
                      setFlowOpen(true);
                    }}
                  />
                ))}
              </VStack>
            </VStack>
          </AsyncState>

          {profile?.contactPhone ? (
            <Card>
              <VStack gap={2}>
                <Heading level={3}>Контакты</Heading>
                <Text as="p">{profile.contactPhone}</Text>
                {profile.address ? <Text type="supporting" as="p">{profile.address}</Text> : null}
                <Button
                  label="Позвонить"
                  variant="secondary"
                  width="100%"
                  href={`tel:${profile.contactPhone.replace(/[^+\d]/g, '')}`}
                />
              </VStack>
            </Card>
          ) : null}
        </VStack>
      </Section>

      <BookingFlow
        service={activeService}
        isOpen={isFlowOpen}
        onClose={() => {
          setFlowOpen(false);
          setActiveService(null);
        }}
        slug={slug}
        timezone={profile?.timezone ?? tenant.boot?.timezone ?? 'UTC'}
        leadMinutes={profile?.booking.leadMinutes ?? 60}
      />
    </>
  );
}
