/* @license Enterprise */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  assertIsDefinedOrThrow,
  findOrThrow,
  isDefined,
  isNonEmptyArray,
} from 'twenty-shared/utils';
import { Not, Repository } from 'typeorm';

import type Stripe from 'stripe';

import {
  BillingException,
  BillingExceptionCode,
} from 'src/engine/core-modules/billing/billing.exception';
import { billingValidator } from 'src/engine/core-modules/billing/billing.validate';
import { BillingCustomerEntity } from 'src/engine/core-modules/billing/entities/billing-customer.entity';
import { BillingSubscriptionEntity } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { BillingProductKey } from 'src/engine/core-modules/billing/enums/billing-product-key.enum';
import { SubscriptionStatus } from 'src/engine/core-modules/billing/enums/billing-subscription-status.enum';
import { BillingSubscriptionService } from 'src/engine/core-modules/billing/services/billing-subscription.service';
import { StripeBillingPortalService } from 'src/engine/core-modules/billing/stripe/services/stripe-billing-portal.service';
import { StripeCheckoutService } from 'src/engine/core-modules/billing/stripe/services/stripe-checkout.service';
import { type BillingGetPricesPerPlanResult } from 'src/engine/core-modules/billing/types/billing-get-prices-per-plan-result.type';
import { type BillingMeterPrice } from 'src/engine/core-modules/billing/types/billing-meter-price.type';
import { type BillingPortalCheckoutSessionParameters } from 'src/engine/core-modules/billing/types/billing-portal-checkout-session-parameters.type';
import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { FeatureFlagKey } from 'twenty-shared/types';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

@Injectable()
export class BillingPortalWorkspaceService {
  protected readonly logger = new Logger(BillingPortalWorkspaceService.name);
  constructor(
    private readonly stripeCheckoutService: StripeCheckoutService,
    private readonly stripeBillingPortalService: StripeBillingPortalService,
    private readonly workspaceDomainsService: WorkspaceDomainsService,
    private readonly billingSubscriptionService: BillingSubscriptionService,
    private readonly featureFlagService: FeatureFlagService,
    @InjectRepository(BillingSubscriptionEntity)
    private readonly billingSubscriptionRepository: Repository<BillingSubscriptionEntity>,
    @InjectRepository(BillingCustomerEntity)
    private readonly billingCustomerRepository: Repository<BillingCustomerEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
  ) {}

  async computeCheckoutSessionURL({
    user,
    workspace,
    billingPricesPerPlan,
    successUrlPath,
    plan,
    requirePaymentMethod,
  }: BillingPortalCheckoutSessionParameters): Promise<string> {
    const { successUrl, cancelUrl, customer, stripeSubscriptionLineItems } =
      await this.prepareSubscriptionParameters({
        workspace,
        billingPricesPerPlan,
        successUrlPath,
      });

    const checkoutSession =
      await this.stripeCheckoutService.createCheckoutSession({
        user,
        workspace,
        stripeSubscriptionLineItems,
        successUrl,
        cancelUrl,
        stripeCustomerId: customer?.stripeCustomerId,
        plan,
        requirePaymentMethod,
        withTrialPeriod:
          !isDefined(customer) || customer.billingSubscriptions.length === 0,
      });

    assertIsDefinedOrThrow(
      checkoutSession.url,
      new BillingException(
        'Error: missing checkout.session.url',
        BillingExceptionCode.BILLING_STRIPE_ERROR,
      ),
    );

    return checkoutSession.url;
  }

  async createDirectSubscription({
    user,
    workspace,
    billingPricesPerPlan,
    successUrlPath,
    plan,
    requirePaymentMethod,
  }: BillingPortalCheckoutSessionParameters): Promise<string> {
    const { successUrl, customer, stripeSubscriptionLineItems } =
      await this.prepareSubscriptionParameters({
        workspace,
        billingPricesPerPlan,
        successUrlPath,
      });

    if (
      isNonEmptyArray(customer?.billingSubscriptions) &&
      customer.billingSubscriptions.some(
        (subscription) => subscription.status !== SubscriptionStatus.Canceled,
      )
    ) {
      throw new BillingException(
        'Customer already has a non-canceled billing subscription',
        BillingExceptionCode.BILLING_SUBSCRIPTION_INVALID,
      );
    }

    const stripeSubscription =
      await this.stripeCheckoutService.createDirectSubscription({
        user,
        workspace,
        stripeSubscriptionLineItems,
        stripeCustomerId: customer?.stripeCustomerId,
        plan,
        requirePaymentMethod,
        withTrialPeriod:
          !isDefined(customer) || customer.billingSubscriptions.length === 0,
      });

    const createdBillingSubscription =
      await this.billingSubscriptionService.syncSubscriptionToDatabase(
        workspace.id,
        stripeSubscription.id,
      );

    await this.billingSubscriptionService.setBillingThresholdsAndTrialPeriodWorkflowCredits(
      createdBillingSubscription.id,
    );

    return successUrl;
  }

  private async prepareSubscriptionParameters({
    workspace,
    billingPricesPerPlan,
    successUrlPath,
  }: {
    workspace: WorkspaceEntity;
    billingPricesPerPlan: BillingGetPricesPerPlanResult;
    successUrlPath?: string;
  }) {
    const frontBaseUrl = this.workspaceDomainsService.buildWorkspaceURL({
      workspace,
    });
    const cancelUrl = frontBaseUrl.toString();

    if (successUrlPath) {
      frontBaseUrl.pathname = successUrlPath;
    }
    const successUrl = frontBaseUrl.toString();

    const quantity = await this.userWorkspaceRepository.countBy({
      workspaceId: workspace.id,
    });

    const customer = await this.billingCustomerRepository.findOne({
      where: { workspaceId: workspace.id },
      relations: ['billingSubscriptions'],
    });

    const stripeSubscriptionLineItems =
      await this.getStripeSubscriptionLineItems({
        quantity,
        billingPricesPerPlan,
        workspaceId: workspace.id,
      });

    return {
      successUrl,
      cancelUrl,
      quantity,
      customer,
      stripeSubscriptionLineItems,
    };
  }

  async computeBillingPortalSessionURLOrThrow(
    workspace: WorkspaceEntity,
    returnUrlPath?: string,
  ) {
    const lastSubscription = await this.billingSubscriptionRepository.findOne({
      where: {
        workspaceId: workspace.id,
        status: Not(SubscriptionStatus.Canceled),
      },
      order: { createdAt: 'DESC' },
    });

    if (!lastSubscription) {
      throw new Error('Error: missing subscription');
    }

    const stripeCustomerId = lastSubscription.stripeCustomerId;

    if (!stripeCustomerId) {
      throw new Error('Error: missing stripeCustomerId');
    }

    const frontBaseUrl = this.workspaceDomainsService.buildWorkspaceURL({
      workspace,
    });

    if (returnUrlPath) {
      frontBaseUrl.pathname = returnUrlPath;
    }
    const returnUrl = frontBaseUrl.toString();

    const session =
      await this.stripeBillingPortalService.createBillingPortalSession(
        stripeCustomerId,
        returnUrl,
      );

    assertIsDefinedOrThrow(
      session.url,
      new BillingException(
        'Error: missing billingPortal.session.url',
        BillingExceptionCode.BILLING_STRIPE_ERROR,
      ),
    );

    return session.url;
  }

  async computeBillingPortalSessionURLForPaymentMethodUpdate(
    workspace: WorkspaceEntity,
    stripeCustomerId: string,
    returnUrlPath?: string,
  ) {
    const frontBaseUrl = this.workspaceDomainsService.buildWorkspaceURL({
      workspace,
    });

    if (returnUrlPath) {
      frontBaseUrl.pathname = returnUrlPath;
    }
    const returnUrl = frontBaseUrl.toString();

    const session =
      await this.stripeBillingPortalService.createBillingPortalSessionForPaymentMethodUpdate(
        stripeCustomerId,
        returnUrl,
      );

    assertIsDefinedOrThrow(
      session.url,
      new BillingException(
        'Error: missing billingPortal.session.url',
        BillingExceptionCode.BILLING_STRIPE_ERROR,
      ),
    );

    return session.url;
  }

  private getDefaultMeteredProductPrice(
    billingPricesPerPlan: BillingGetPricesPerPlanResult,
  ): BillingMeterPrice {
    const defaultMeteredProductPrice =
      billingPricesPerPlan.meteredProductsPrices.reduce(
        (result, billingPrice) => {
          if (!result) {
            return billingPrice as BillingMeterPrice;
          }
          const tiers = billingPrice.tiers;

          if (billingValidator.isMeteredTiersSchema(tiers)) {
            if (tiers[0].flat_amount < result.tiers[0].flat_amount) {
              return billingPrice as BillingMeterPrice;
            }
          }

          return result;
        },
        null as BillingMeterPrice | null,
      );

    if (!isDefined(defaultMeteredProductPrice)) {
      throw new BillingException(
        'Missing Default Metered price',
        BillingExceptionCode.BILLING_PRICE_NOT_FOUND,
      );
    }

    return defaultMeteredProductPrice;
  }

  // V2 path — finds the lowest credit_amount RESOURCE_CREDIT licensed price as default
  private getDefaultCreditPackPrice(
    billingPricesPerPlan: BillingGetPricesPerPlanResult,
  ) {
    const creditPackPrices = billingPricesPerPlan.licensedProductsPrices.filter(
      (price) =>
        price.billingProduct?.metadata?.productKey ===
        BillingProductKey.RESOURCE_CREDIT,
    );

    if (!isDefined(creditPackPrices) || creditPackPrices.length === 0) {
      throw new BillingException(
        'Missing Default RESOURCE_CREDIT price',
        BillingExceptionCode.BILLING_PRICE_NOT_FOUND,
      );
    }

    return creditPackPrices.reduce((lowest, price) => {
      const amount = Number(price.metadata?.credit_amount ?? 0);
      const lowestAmount = Number(lowest.metadata?.credit_amount ?? 0);

      return amount < lowestAmount ? price : lowest;
    });
  }

  private async getStripeSubscriptionLineItems({
    quantity,
    billingPricesPerPlan,
    workspaceId,
  }: {
    quantity: number;
    billingPricesPerPlan: BillingGetPricesPerPlanResult;
    workspaceId: string;
  }): Promise<Stripe.Checkout.SessionCreateParams.LineItem[]> {
    const isV2 = await this.featureFlagService.isFeatureEnabled(
      FeatureFlagKey.IS_BILLING_V2_ENABLED,
      workspaceId,
    );

    const defaultLicensedProductPrice = findOrThrow(
      billingPricesPerPlan.licensedProductsPrices,
      (licensedProductsPrice) =>
        licensedProductsPrice.billingProduct?.metadata.productKey ===
        BillingProductKey.BASE_PRODUCT,
      new BillingException(
        `Base product not found`,
        BillingExceptionCode.BILLING_PRICE_NOT_FOUND,
      ),
    );

    if (isV2) {
      const defaultCreditPackPrice =
        this.getDefaultCreditPackPrice(billingPricesPerPlan);

      return [
        {
          price: defaultLicensedProductPrice.stripePriceId,
          quantity,
        },
        {
          price: defaultCreditPackPrice.stripePriceId,
          quantity: 1,
        },
      ];
    }

    const defaultMeteredProductPrice =
      this.getDefaultMeteredProductPrice(billingPricesPerPlan);

    return [
      {
        price: defaultLicensedProductPrice.stripePriceId,
        quantity,
      },
      {
        price: defaultMeteredProductPrice.stripePriceId,
      },
    ];
  }
}
