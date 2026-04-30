import { currentWorkspaceState } from '@/auth/states/currentWorkspaceState';
import { useCurrentPlan } from '@/settings/billing/hooks/useCurrentPlan';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';
import { isDefined } from 'twenty-shared/utils';
import {
  BillingProductKey,
  type BillingPriceLicensed,
  type SubscriptionInterval,
} from '~/generated-metadata/graphql';

// V2 hook — reads the RESOURCE_CREDIT subscription item and available pack prices
// from licensedProducts. Counterpart of useCurrentMetered for V2 workspaces.
export const useCurrentCreditPack = () => {
  const { currentPlan } = useCurrentPlan();
  const currentWorkspace = useAtomStateValue(currentWorkspaceState);

  const getCreditPackPricesByInterval = (
    interval?: SubscriptionInterval | null,
  ): BillingPriceLicensed[] => {
    const creditPackProducts = currentPlan.licensedProducts.filter(
      (product) =>
        product.metadata?.productKey === BillingProductKey.RESOURCE_CREDIT,
    );

    const prices = creditPackProducts
      .flatMap((product) => product.prices ?? [])
      .filter((price): price is BillingPriceLicensed => isDefined(price));

    return interval
      ? prices.filter((p) => p.recurringInterval === interval)
      : prices;
  };

  const items =
    currentWorkspace?.currentBillingSubscription?.billingSubscriptionItems;

  const currentCreditPackSubscriptionItem = items?.find(
    (item) =>
      item.billingProduct.metadata?.['productKey'] ===
      BillingProductKey.RESOURCE_CREDIT,
  );

  const creditPackPrices = getCreditPackPricesByInterval();

  const currentCreditPackBillingPrice = creditPackPrices.find(
    (price) =>
      price.stripePriceId ===
      currentCreditPackSubscriptionItem?.stripePriceId,
  );

  return {
    currentCreditPackSubscriptionItem,
    currentCreditPackBillingPrice,
    getCreditPackPricesByInterval,
  };
};
