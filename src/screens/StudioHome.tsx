/**
 * The studio's front screen.
 *
 * Data comes from the database when a project is attached. When it is not, the
 * screen falls back to the configuration published at build time — so a hosted
 * preview shows the studio's real name, photographs, services, prices, hours and
 * contacts instead of an empty shell.
 *
 * The one thing the fallback cannot do is take a booking, and the interface says
 * so: free slots live in `resource_occupancies`, which a static file cannot hold.
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
import { formatDuration, formatMoney, formatTime, weekdayName, todayInZone, addDaysToIsoDate } from '@/lib/format';
import { useTenant } from '@/tenant/TenantProvider';
import type { PublicService } from '@shared/tenant-types';

function ServiceCard({
  service,
  slug,
  timezone,
  canBook,
  onChoose,
}: {
  service: PublicService;
  slug: string;
  timezone: string;
  canBook: boolean;
  onChoose: (service: PublicService) => void;
}) {
  const from = todayInZone(timezone);
  const to = addDaysToIsoDate(from, 7);

  // Availability is a database question. Asking it without one would produce a
  // spinner that can never resolve, so it is not asked at all.
  const slots = useQuery({
    queryKey: ['slots', slug, service.key, from, to],
    enabled: canBook && slug.length > 0,
    staleTime: 15_000,
    queryFn: () => fetchSlots(slug, service.key, from, to),
  });

  const nextSlot = slots.data?.[0];

  return (
    <Card>
      <VStack gap={3}>
        {service.imageUrl ? (
          <img
            src={service.imageUrl}
            alt={service.name}
            width={800}
            height={600}
            loading="lazy"
            decoding="async"
            className="h-40 w-full rounded-lg bg-secondary object-cover"
          />
        ) : null}

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

        <HStack gap={2} align="center" wrap="wrap">
          <Text type="supporting">{formatDuration(service.durationMin)}</Text>
          {service.spansDays ? <Badge label="Несколько дней" /> : null}
          {service.category ? <Badge label={service.category} /> : null}
        </HStack>

        {canBook && slots.isError ? (
          <Banner
            status="warning"
            title="Свободные окна не загрузились"
            description="Можно всё равно начать запись — окна подтянутся на следующем шаге."
          />
        ) : null}

        {canBook && !slots.isLoading && !slots.isError && !nextSlot ? (
          <Text type="supporting">На ближайшую неделю свободных окон нет.</Text>
        ) : null}

        {canBook && nextSlot ? (
          <Text type="supporting">
            Ближайшее окно: {formatTime(nextSlot.slot_start, timezone)}
          </Text>
        ) : null}

        <Button
          label={canBook ? 'Записаться' : 'Запись по телефону'}
          variant="primary"
          width="100%"
          isDisabled={!canBook}
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

  const profile = tenant.profile;
  const slug = tenant.boot?.slug ?? '';
  const timezone = profile?.timezone ?? tenant.boot?.timezone ?? 'UTC';
  const hero = profile?.assets.find((asset) => asset.kind === 'hero') ?? null;
  const gallery = (profile?.assets ?? []).filter((asset) => asset.kind === 'gallery');

  return (
    <>
      <Section padding={4}>
        <VStack gap={5}>
          {hero?.url ? (
            <img
              src={hero.url}
              alt={hero.alt ?? profile?.name ?? ''}
              width={1600}
              height={900}
              // the hero is the largest contentful paint element, so it is eager
              loading="eager"
              decoding="async"
              className="h-52 w-full rounded-lg bg-secondary object-cover"
            />
          ) : null}

          <VStack gap={1}>
            <Heading level={1}>{profile?.name ?? tenant.boot?.name ?? 'Студия'}</Heading>
            {profile?.tagline ? (
              <Text type="supporting" as="p">
                {profile.tagline}
              </Text>
            ) : null}
            {profile?.address ? (
              <Text type="supporting" as="p">
                {profile.address}
              </Text>
            ) : null}
          </VStack>

          {tenant.source === 'published-snapshot' ? (
            <Banner
              status="info"
              title="Предпросмотр студии"
              description="База данных не подключена, поэтому онлайн-запись недоступна. Ниже — опубликованная конфигурация студии: услуги, цены и часы работы."
            />
          ) : null}

          {tenant.source === 'none' && !tenant.isLoading ? (
            <Banner
              status="warning"
              title="Нет ни базы, ни опубликованной конфигурации"
              description="Соберите приложение командой npm run build — она публикует конфигурацию студии. Для онлайн-записи задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY."
            />
          ) : null}

          {profile?.status === 'preview' ? (
            <Banner
              status="info"
              title="Демо-режим"
              description="Студия опубликована как предпросмотр: реальные уведомления не отправляются."
            />
          ) : null}

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
                    timezone={timezone}
                    canBook={tenant.canBook}
                    onChoose={(chosen) => {
                      if (!tenant.canBook) return;
                      setActiveService(chosen);
                      setFlowOpen(true);
                    }}
                  />
                ))}
              </VStack>
            </VStack>
          </AsyncState>

          {profile && profile.hours.length > 0 ? (
            <Card>
              <VStack gap={2}>
                <Heading level={3}>Часы работы</Heading>
                {profile.hours.map((row) => (
                  <HStack key={row.weekday} gap={2} justify="between">
                    <Text type="supporting">{weekdayName(row.weekday)}</Text>
                    <Text type="supporting" hasTabularNumbers>
                      {row.isClosed ? 'выходной' : `${row.opensAt}–${row.closesAt}`}
                    </Text>
                  </HStack>
                ))}
                <Text type="supporting" as="p">
                  Часовой пояс: {timezone}
                </Text>
              </VStack>
            </Card>
          ) : null}

          {gallery.length > 0 ? (
            <VStack gap={2}>
              <Heading level={3}>Фотографии</Heading>
              <HStack gap={2} wrap="wrap">
                {gallery.map((asset) => (
                  <img
                    key={asset.url ?? asset.alt ?? 'gallery'}
                    src={asset.url ?? ''}
                    alt={asset.alt ?? profile?.name ?? ''}
                    width={1200}
                    height={800}
                    loading="lazy"
                    decoding="async"
                    className="h-32 flex-1 rounded-lg bg-secondary object-cover"
                  />
                ))}
              </HStack>
            </VStack>
          ) : null}

          {profile?.contactPhone || profile?.contactWhatsapp || profile?.contactTelegram ? (
            <Card>
              <VStack gap={3}>
                <Heading level={3}>Контакты</Heading>
                {profile.contactPhone ? (
                  <>
                    <Text as="p">{profile.contactPhone}</Text>
                    <Button
                      label="Позвонить"
                      variant="primary"
                      width="100%"
                      {...{ href: `tel:${profile.contactPhone.replace(/[^+\d]/g, '')}` }}
                    />
                  </>
                ) : null}
                {profile.contactWhatsapp ? (
                  <Button
                    label="WhatsApp"
                    variant="secondary"
                    width="100%"
                    {...{ href: profile.contactWhatsapp }}
                  />
                ) : null}
                {profile.contactTelegram ? (
                  <Button
                    label="Telegram"
                    variant="secondary"
                    width="100%"
                    {...{ href: profile.contactTelegram }}
                  />
                ) : null}
                {profile.contactEmail ? (
                  <Text type="supporting" as="p">
                    {profile.contactEmail}
                  </Text>
                ) : null}
              </VStack>
            </Card>
          ) : null}
        </VStack>
      </Section>

      {/* Only mounted when a booking can actually be placed. */}
      {tenant.canBook ? (
        <BookingFlow
          service={activeService}
          isOpen={isFlowOpen}
          onClose={() => {
            setFlowOpen(false);
            setActiveService(null);
          }}
          slug={slug}
          timezone={timezone}
          leadMinutes={profile?.booking.leadMinutes ?? 60}
        />
      ) : null}
    </>
  );
}
