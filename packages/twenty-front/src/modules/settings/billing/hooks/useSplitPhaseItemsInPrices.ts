import { useNextBillingPhase } from '@/settings/billing/hooks/useNextBillingPhase';
import { usePriceAndBillingUsageByPriceId } from '@/settings/billing/hooks/usePriceAndBillingUsageByPriceId';
import { useIsFeatureEnabled } from '@/workspace/hooks/useIsFeatureEnabled';
import { type MeteredBillingPrice } from '@/settings/billing/types/billing-price-tiers.type';
import {
  BillingUsageType,
  type BillingPriceLicensed,
  FeatureFlagKey,
} from '~/generated-metadata/graphql';
import { isDefined } from 'twenty-shared/utils';

export const useSplitPhaseItemsInPrices = () => {
  const { nextBillingPhase } = useNextBillingPhase();
  const { getPriceAndBillingUsageByPriceId } =
    usePriceAndBillingUsageByPriceId();
  const isV2 = useIsFeatureEnabled(FeatureFlagKey.IS_BILLING_V2_ENABLED);

  const splitedPhaseItemsInPrices = (nextBillingPhase?.items ?? []).reduce(
    (acc, item) => {
      const { price, billingUsage } = getPriceAndBillingUsageByPriceId(
        item.price,
      );

      if (isV2) {
        if (billingUsage === BillingUsageType.LICENSED) {
          const licensedPrice = price as BillingPriceLicensed;
          if (isDefined(licensedPrice.creditAmount)) {
            acc.nextCreditPackPrice = licensedPrice;
          } else {
            acc.nextLicensedPrice = licensedPrice;
          }
        }
      } else {
        if (billingUsage === BillingUsageType.LICENSED) {
          acc.nextLicensedPrice = price;
        }
        if (billingUsage === BillingUsageType.METERED) {
          acc.nextMereredPrice = price as MeteredBillingPrice;
        }
      }
      return acc;
    },
    {} as {
      nextMereredPrice: MeteredBillingPrice | undefined;
      nextLicensedPrice: BillingPriceLicensed | undefined;
      nextCreditPackPrice: BillingPriceLicensed | undefined;
    },
  );

  return { splitedPhaseItemsInPrices };
};
