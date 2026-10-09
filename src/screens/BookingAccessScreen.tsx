/**
 * `/booking?t=<token>` — the customer's own booking, reachable without an
 * account. The token is the only credential and it is never stored in the
 * database in plaintext.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { VStack, HStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';
import { AsyncState } from '@/components/AsyncState';
import { bookingIcsUrl, cancelBooking, fetchSlots, getBooking, rescheduleBooking } from '@/lib/api';
import { formatDay, formatDuration, formatMoney, formatTime, statusLabel, todayInZone, addDaysToIsoDate } from '@/lib/format';
import { createPushSubscription, supportsPush } from '@/pwa/register';
import { subscribeToPush } from '@/lib/api';

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}`;
}

export function BookingAccessScreen() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [reason, setReason] = useState('');
  const [newStart, setNewStart] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pushState, setPushState] = useState<'idle' | 'asking' | 'granted' | 'unsupported' | 'failed'>('idle');

  const booking = useQuery({
    queryKey: ['booking', token],
    enabled: token.length > 0,
    retry: 0,
    queryFn: () => getBooking(token),
  });

  const timezone = booking.data?.timezone ?? 'UTC';
  const serviceKey = booking.data?.serviceKey ?? '';

  const slots = useQuery({
    queryKey: ['reschedule-slots', serviceKey, timezone],
    enabled: Boolean(booking.data?.canReschedule && serviceKey),
    staleTime: 10_000,
    queryFn: () =>
      fetchSlots(
        booking.data!.tenantSlug,
        serviceKey,
        todayInZone(timezone),
        addDaysToIsoDate(todayInZone(timezone), 21),
      ),
  });

  const cancel = useMutation({
    mutationFn: () => cancelBooking(token, reason, newIdempotencyKey()),
    onSuccess: () => {
      setNotice('Запись отменена.');
      void booking.refetch();
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const move = useMutation({
    mutationFn: () => rescheduleBooking(token, newStart, newIdempotencyKey()),
    onSuccess: () => {
      setNotice('Запись перенесена.');
      setNewStart('');
      void booking.refetch();
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const availableStarts = useMemo(
    () => (slots.data ?? []).slice(0, 40),
    [slots.data],
  );

  const icsUrl = token ? bookingIcsUrl(token) : null;

  if (!token) {
    return (
      <Section padding={4}>
        <Banner
          status="warning"
          title="Нужна ссылка из подтверждения"
          description="Откройте ссылку, которую студия отправила после записи."
        />
      </Section>
    );
  }

  const record = booking.data;

  return (
    <Section padding={4}>
      <VStack gap={4}>
        <Heading level={1}>Моя запись</Heading>

        {notice ? <Banner status="info" title={notice} /> : null}

        <AsyncState
          isLoading={booking.isLoading}
          error={booking.error}
          isEmpty={!record}
          emptyTitle="Запись не найдена"
          onRetry={() => {
            void booking.refetch();
          }}
        >
          {record ? (
            <VStack gap={4}>
              <Card>
                <VStack gap={3}>
                  <HStack gap={2} justify="between" align="center">
                    <Heading level={2}>{record.serviceName}</Heading>
                    <Badge label={statusLabel(record.status).label} />
                  </HStack>

                  <VStack gap={1}>
                    <Text as="p">
                      {formatDay(record.startsAt, timezone)} · {formatTime(record.startsAt, timezone)}–
                      {formatTime(record.endsAt, timezone)}
                    </Text>
                    <Text type="supporting" as="p">
                      {formatDuration(record.durationMin)} · {record.resourceName} ·{' '}
                      {formatMoney(record.priceCents, record.currency)}
                    </Text>
                    <Text type="supporting" as="p">
                      {record.tenantName}, номер записи {record.displayNumber}
                    </Text>
                  </VStack>

                  {icsUrl ? (
                    <Button
                      label="Добавить в календарь (.ics)"
                      variant="secondary"
                      width="100%"
                      {...{ href: icsUrl }}
                    />
                  ) : null}
                </VStack>
              </Card>

              {record.payments.length > 0 ? (
                <Card>
                  <VStack gap={2}>
                    <Heading level={3}>Платежи</Heading>
                    {record.payments.map((payment) => (
                      <HStack key={payment.id} gap={2} justify="between">
                        <Text type="supporting">{payment.method}</Text>
                        <Text>
                          {formatMoney(payment.amountCents, payment.currency)} · {payment.status}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                </Card>
              ) : null}

              {/* Push is an extra channel, and the interface says so honestly. */}
              <Card>
                <VStack gap={2}>
                  <Heading level={3}>Напоминания</Heading>
                  {supportsPush() ? (
                    <>
                      <Text type="supporting" as="p">
                        Напоминание придёт, если приложение добавлено на главный экран. В обычной
                        вкладке iPhone уведомления не доставляются — это ограничение системы, а не
                        студии.
                      </Text>
                      <Button
                        label={pushState === 'granted' ? 'Напоминания включены' : 'Включить напоминания'}
                        variant="secondary"
                        width="100%"
                        isDisabled={pushState === 'granted' || pushState === 'asking'}
                        clickAction={async () => {
                          setPushState('asking');
                          try {
                            const subscription = await createPushSubscription();
                            const endpoint = subscription?.endpoint;
                            if (!subscription || !endpoint) {
                              setPushState('failed');
                              return;
                            }
                            await subscribeToPush({
                              slug: record.tenantSlug,
                              audience: 'customer',
                              token,
                              subscription: {
                                endpoint,
                                keys: {
                                  p256dh: subscription.keys?.p256dh ?? '',
                                  auth: subscription.keys?.auth ?? '',
                                },
                              },
                              userAgent: navigator.userAgent,
                            });
                            setPushState('granted');
                          } catch {
                            setPushState('failed');
                          }
                        }}
                      />
                    </>
                  ) : (
                    <Text type="supporting" as="p">
                      Push не настроен на этом устройстве: не задан публичный VAPID-ключ. Ссылка на
                      запись и .ics работают как обычно.
                    </Text>
                  )}
                </VStack>
              </Card>

              {record.canReschedule ? (
                <Card>
                  <VStack gap={3}>
                    <Heading level={3}>Перенести</Heading>
                    {slots.isLoading ? <Text type="supporting">Загружаем свободные окна…</Text> : null}
                    {slots.isError ? (
                      <Banner
                        status="error"
                        title="Окна не загрузились"
                        description={(slots.error as Error).message}
                      />
                    ) : null}
                    {!slots.isLoading && availableStarts.length === 0 ? (
                      <Text type="supporting">Свободных окон нет.</Text>
                    ) : null}
                    <VStack gap={2}>
                      {availableStarts.map((slot) => (
                        <Button
                          key={slot.slot_start}
                          label={`${formatDay(slot.slot_start, timezone)}, ${formatTime(slot.slot_start, timezone)} · ${slot.slot_resource_name}`}
                          variant={newStart === slot.slot_start ? 'primary' : 'secondary'}
                          width="100%"
                          onClick={() => setNewStart(slot.slot_start)}
                        />
                      ))}
                    </VStack>
                    <Button
                      label="Перенести на выбранное время"
                      variant="primary"
                      width="100%"
                      isDisabled={!newStart}
                      isLoading={move.isPending}
                      clickAction={async () => {
                        await move.mutateAsync();
                      }}
                    />
                  </VStack>
                </Card>
              ) : null}

              {record.canCancel ? (
                <Card>
                  <VStack gap={3}>
                    <Heading level={3}>Отменить</Heading>
                    <TextInput label="Причина (необязательно)" value={reason} onChange={setReason} isOptional />
                    <Button
                      label="Отменить запись"
                      variant="destructive"
                      width="100%"
                      isLoading={cancel.isPending}
                      clickAction={async () => {
                        await cancel.mutateAsync();
                      }}
                    />
                  </VStack>
                </Card>
              ) : (
                <Banner
                  status="info"
                  title="Изменения недоступны"
                  description={`Перенести или отменить запись можно не позднее чем за ${record.minCancelNoticeMinutes} минут до начала. Позвоните в студию.`}
                />
              )}
            </VStack>
          ) : null}
        </AsyncState>
      </VStack>
    </Section>
  );
}
