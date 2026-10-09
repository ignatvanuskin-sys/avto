/**
 * In-app 404.
 *
 * The static host answers unknown deep paths with its own 404 document, but any
 * path that does reach the bundle (a typo inside a studio, an unknown studio
 * slug, a stale link) must still land on something a person can act on rather
 * than a blank screen or, worse, a different studio's shell.
 */
import { VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';

export function NotFoundScreen({
  reason,
  hint,
}: {
  reason?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <Section padding={4}>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={1}>Страница не найдена</Heading>
          <Text type="supporting" as="p">
            {reason ?? 'Такой страницы нет или ссылка устарела.'}
          </Text>
          {hint ? (
            <Text type="supporting" as="p">
              {hint}
            </Text>
          ) : null}
        </VStack>

        <VStack gap={2}>
          <Button
            label="К списку студий"
            variant="primary"
            width="100%"
            onClick={() => {
              window.location.href = '/';
            }}
          />
          <Button
            label="На главную студии"
            variant="secondary"
            width="100%"
            onClick={() => {
              window.location.reload();
            }}
          />
        </VStack>
      </VStack>
    </Section>
  );
}
