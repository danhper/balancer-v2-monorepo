import { expect } from 'chai';
import { ethers } from 'hardhat';
import { BigNumber, Contract, ContractTransaction } from 'ethers';

import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { PoolSpecialization, SwapKind } from '@balancer-labs/balancer-js';
import { BigNumberish, bn, fp, pct, FP_SCALING_FACTOR } from '@balancer-labs/v2-helpers/src/numbers';
import { MAX_UINT112, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { RawStablePhantomPoolDeployment } from '@balancer-labs/v2-helpers/src/models/pools/stable-phantom/types';
import { advanceTime, currentTimestamp, DAY, MINUTE, MONTH } from '@balancer-labs/v2-helpers/src/time';
import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import StablePhantomPool from '@balancer-labs/v2-helpers/src/models/pools/stable-phantom/StablePhantomPool';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { Account } from '@balancer-labs/v2-helpers/src/models/types/types';

describe('StablePhantomPool', () => {
  let lp: SignerWithAddress,
    owner: SignerWithAddress,
    recipient: SignerWithAddress,
    admin: SignerWithAddress,
    other: SignerWithAddress;

  const AMPLIFICATION_PARAMETER = bn(200);
  const PREMINTED_BPT = MAX_UINT112.div(2);

  sharedBeforeEach('setup signers', async () => {
    [, lp, owner, recipient, admin, other] = await ethers.getSigners();
  });

  context('for a 1 token pool', () => {
    it('reverts', async () => {
      const tokens = await TokenList.create(1);
      await expect(StablePhantomPool.create({ tokens })).to.be.revertedWith('MIN_TOKENS');
    });
  });

  context('for a 2 token pool', () => {
    itBehavesAsStablePhantomPool(2);
  });

  context('for a 3 token pool', () => {
    itBehavesAsStablePhantomPool(3);
  });

  context('for a 4 token pool', () => {
    itBehavesAsStablePhantomPool(4);
  });

  context('for a 5 token pool', () => {
    itBehavesAsStablePhantomPool(5);
  });

  context('for a 6 token pool', () => {
    it('reverts', async () => {
      const tokens = await TokenList.create(6, { sorted: true });
      await expect(StablePhantomPool.create({ tokens })).to.be.revertedWith('MAX_TOKENS');
    });
  });

  describe('with non-18 decimal tokens', () => {
    // Use non-round numbers
    const SWAP_FEE_PERCENTAGE = fp(0.0234);
    const PROTOCOL_SWAP_FEE_PERCENTAGE = fp(0.34);

    let tokens: TokenList;
    let pool: StablePhantomPool;
    let bptIndex: number;
    let initialBalances: BigNumberish[];
    let scalingFactors: BigNumber[];
    let tokenRates: BigNumber[];
    let protocolFeesCollector: Contract;
    let previousFeeBalance: BigNumber;

    const rateProviders: Contract[] = [];
    const tokenRateCacheDurations: BigNumberish[] = [];
    const exemptFromYieldProtocolFeeFlags: boolean[] = [];

    // Used a fixed 5-token pool with all non-18 decimal tokens, including extreme values (0, 17),
    // and common non-18 values (6, 8).
    sharedBeforeEach('deploy tokens', async () => {
      // Ensure we cover the full range, from 0 to 17
      // Including common non-18 values of 6 and 8
      tokens = await TokenList.create([
        { decimals: 17, symbol: 'TK17' },
        { decimals: 11, symbol: 'TK11' },
        { decimals: 8, symbol: 'TK8' },
        { decimals: 6, symbol: 'TK6' },
        { decimals: 0, symbol: 'TK0' },
      ]);
      // NOTE: must sort after creation!
      // TokenList.create with the sort option will strip off the decimals
      tokens = tokens.sort();
      tokenRates = Array.from({ length: tokens.length }, (_, i) => fp(1 + (i + 1) / 10));

      // Balances are all "100" to the Vault
      initialBalances = Array(tokens.length + 1).fill(fp(100));
      // Except the BPT token, which is 0
      initialBalances[bptIndex] = fp(0);
    });

    function _skipBptIndex(bptIndex: number, index: number): number {
      return index < bptIndex ? index : index - 1;
    }

    function _dropBptItem(bptIndex: number, items: BigNumberish[]): BigNumberish[] {
      const result = [];
      for (let i = 0; i < items.length - 1; i++) result[i] = items[i < bptIndex ? i : i + 1];
      return result;
    }

    async function deployPool(
      params: RawStablePhantomPoolDeployment = {},
      rates: BigNumberish[] = [],
      protocolSwapFeePercentage: BigNumber
    ): Promise<void> {
      // 0th token has no rate provider, to test that case
      const rateProviderAddresses: Account[] = Array(tokens.length).fill(ZERO_ADDRESS);
      tokenRateCacheDurations[0] = 0;
      exemptFromYieldProtocolFeeFlags[0] = false;

      for (let i = 1; i < tokens.length; i++) {
        rateProviders[i] = await deploy('v2-pool-utils/MockRateProvider');
        rateProviderAddresses[i] = rateProviders[i].address;

        await rateProviders[i].mockRate(rates[i] || fp(1));
        tokenRateCacheDurations[i] = params.tokenRateCacheDurations ? params.tokenRateCacheDurations[i] : 0;
        exemptFromYieldProtocolFeeFlags[i] = params.exemptFromYieldProtocolFeeFlags
          ? params.exemptFromYieldProtocolFeeFlags[i]
          : false;
      }

      pool = await StablePhantomPool.create({
        tokens,
        rateProviders: rateProviderAddresses,
        tokenRateCacheDurations,
        exemptFromYieldProtocolFeeFlags,
        owner,
        admin,
        ...params,
      });

      bptIndex = await pool.getBptIndex();
      scalingFactors = await pool.getScalingFactors();

      await pool.vault.setSwapFeePercentage(protocolSwapFeePercentage);
      await pool.updateProtocolFeePercentageCache();
      protocolFeesCollector = await pool.vault.getFeesCollector();
      previousFeeBalance = await pool.balanceOf(protocolFeesCollector.address);
    }

    async function initializePool(): Promise<void> {
      // This is the unscaled input for the balances. For instance, "100" is "100" for 0 decimals, and "100000000" for 6 decimals
      const unscaledBalances = await pool.downscale(initialBalances);

      for (let i = 0; i < initialBalances.length; i++) {
        if (i != bptIndex) {
          const token = tokens.get(_skipBptIndex(bptIndex, i));
          await token.instance.mint(recipient.address, unscaledBalances[i]);
        }
      }
      await tokens.approve({ from: recipient, to: pool.vault });
      await pool.init({ recipient, initialBalances: unscaledBalances });
    }

    context('with unary rates', () => {
      sharedBeforeEach('initialize pool', async () => {
        // Set rates to 1 to test decimal scaling independently
        const unaryRates = Array(tokens.length).fill(fp(1));

        await deployPool(
          { swapFeePercentage: SWAP_FEE_PERCENTAGE, amplificationParameter: AMPLIFICATION_PARAMETER },
          unaryRates,
          PROTOCOL_SWAP_FEE_PERCENTAGE
        );

        await initializePool();
      });

      it('sets scaling factors', async () => {
        const tokenScalingFactors: BigNumber[] = [];

        for (let i = 0; i < tokens.length + 1; i++) {
          if (i == bptIndex) {
            tokenScalingFactors[i] = fp(1);
          } else {
            const j = _skipBptIndex(bptIndex, i);
            tokenScalingFactors[i] = fp(10 ** (18 - tokens.get(j).decimals));
          }
        }

        expect(tokenScalingFactors).to.deep.equal(scalingFactors);
      });

      it('initializes with uniform initial balances', async () => {
        const balances = await pool.getBalances();
        // Upscaling the result will recover the initial balances: all fp(100)
        const upscaledBalances = await pool.upscale(balances);

        expect(_dropBptItem(bptIndex, upscaledBalances)).to.deep.equal(_dropBptItem(bptIndex, initialBalances));
      });

      it('grants the invariant amount of BPT', async () => {
        const balances = await pool.getBalances();
        const invariant = await pool.estimateInvariant(await pool.upscale(balances));

        // Initial balances should equal invariant
        expect(await pool.balanceOf(recipient)).to.be.equalWithError(invariant, 0.001);
      });
    });

    /**
     * The intent here is to test every path through the code, ensuring decimal scaling and rate scaling are
     * correctly employed in each case, and the protocol fees collected match expectations.
     */
    describe('protocol fees, scaling, and rates', () => {
      const tokenNoRateIndex = 0;
      const tokenWithRateIndex = 1;
      const tokenWithRateExemptIndex = 2; // exempt flags are set for "even" indices (2 and 4)

      sharedBeforeEach('initialize pool', async () => {
        // Set indices 2 and 4 to be exempt (even)
        const exemptFlags = [false, false, true, false, true];

        await deployPool(
          {
            swapFeePercentage: SWAP_FEE_PERCENTAGE,
            amplificationParameter: AMPLIFICATION_PARAMETER,
            exemptFromYieldProtocolFeeFlags: exemptFlags,
          },
          tokenRates,
          PROTOCOL_SWAP_FEE_PERCENTAGE
        );

        await initializePool();
      });

      // Do a bunch of regular swaps to incur fees / change the invariant
      async function incurProtocolFees(): Promise<void> {
        // This should change the balance of all tokens (at least the 3 being used below)
      }

      /**
       * A swap could be:
       * 1) regular swap, given in or out, between two non-BPT tokens
       * 2) a BPT swap, given in or out: one of the tokens is the BPT token
       *
       * Regular swaps have no interaction with the protocol fee system, but they change balances,
       * causing the invariant to increase.
       *
       * BPT swaps are joins or exits, so they trigger payment of protocol fees
       * (and updating the cache needed for the next join/exit)
       */
      describe('swaps', () => {
        /**
         * 1) StablePhantomPool.onSwap:
         *    update rates, if necessary (can set the duration to 0 so it will always update them)
         *    This is done to ensure we are *always* using the latest rates for operations (e.g.,
         *    if swaps are infrequent and we didn't do this, the rate could be very stale)
         * 2) BaseGeneralPool.onSwap:
         *    compute scaling factors, which includes both token decimals and rates
         *    determine GivenIn vs. GivenOut
         *        StablePhantomPool._swapGivenIn:
         *            Determine it is a regular swap
         *            BaseGeneralPool._swapGivenIn:
         *                Subtract swap fee from amountIn
         *                Apply scaling to balances and amounts
         *                Call StablePhantomPool._onSwapGivenIn to compute amountOut: see #3
         *                Downscale amountOut and return to Vault
         *        StablePhantomPool._swapGivenOut:
         *            Determine it is a regular swap
         *            BaseGeneralPool._swapGivenOut:
         *                Apply scaling to balances and amounts
         *                Call StablePhantomPool._onSwapGivenOut to compute amountIn: see #3
         *                Add swap fee to amountIn
         *                Downscale amountIn and return to Vault
         * 3) StablePhantomPool._onSwapGivenIn/Out:
         *        StablePhantomPool._onRegularSwap:
         *            Call StableMath with scaled balances and current amp to compute amountIn/Out
         */
        context('regular swaps', () => {
          // Swap 10% of the value
          let unscaledAmounts: BigNumberish[];

          sharedBeforeEach('calculate swap amounts', async () => {
            // These will be the "downscaled" raw input swap amounts
            const scaledSwapAmounts = Array(tokens.length).fill(fp(10));
            unscaledAmounts = await pool.downscale(scaledSwapAmounts);
            expect(previousFeeBalance).to.be.zero;
          });

          function itPerformsARegularSwap(kind: SwapKind, indexIn: number, indexOut: number) {
            it('performs a regular swap', async () => {
              // const amount = kind == SwapKind.GivenIn ? unscaledAmounts[indexIn] : unscaledAmounts[indexOut];
              const rateFactor = fp(1.1);
              let oldRate: BigNumber;

              console.log(`unscaled amounts: ${unscaledAmounts}`);
              // predict results
              // do swap
              // validate results

              // Change rates between GivenIn and GivenOut
              if (kind == SwapKind.GivenIn) {
                // Change rate (remember 0 has no provider)
                if (indexIn > 0) {
                  oldRate = await rateProviders[indexIn].getRate();
                  await rateProviders[indexIn].mockRate(
                    Math.random() > 0.5 ? oldRate.mul(rateFactor) : oldRate.div(rateFactor)
                  );
                }
                oldRate = await rateProviders[indexOut].getRate();
                await rateProviders[indexOut].mockRate(
                  Math.random() > 0.5 ? oldRate.mul(rateFactor) : oldRate.div(rateFactor)
                );
              }
            });
          }

          // Swap each token with the next (don't need all permutations), both GivenIn and GivenOut, changing
          // rates in between. i < tokens.length - 1; tokens isn't defined outside an it
          for (let i = 0; i < 4; i++) {
            itPerformsARegularSwap(SwapKind.GivenIn, i, i + 1);
            // The GivenIn swap changes the rate
            itPerformsARegularSwap(SwapKind.GivenOut, i, i + 1);
          }
        });

        /**
         * 1) StablePhantomPool.onSwap:
         *    update rates, if necessary (can set the duration to 0 so it will always update them)
         *    This is done to ensure we are *always* using the latest rates for operations (e.g.,
         *    if swaps are infrequent and we didn't do this, the rate could be very stale)
         * 2) BaseGeneralPool.onSwap:
         *    compute scaling factors, which includes both token decimals and rates
         *    determine GivenIn vs. GivenOut
         *        StablePhantomPool._swapGivenIn:
         *            Determine it is a BPT swap
         *            StablePhantomPool._swapWithBpt:
         *                Apply scaling factors to balances
         *                Pay protocol fees (based on invariant growth)
         *                Call StablePhantomPool._onSwapBptGivenIn to compute amountOut; see #3
         *                Downscale amountOut and return to Vault
         *        StablePhantomPool._swapGivenOut:
         *            Determine it is a BPT swap
         *            StablePhantomPool._swapWithBpt:
         *                Apply scaling factors to balances
         *                Pay protocol fees (based on invariant growth)
         *                Call StablePhantomPool._onSwapBptGivenOut to compute amountIn; see #3
         *                Downscale amountIn and return to Vault
         * 3) StablePhantomPool._onSwapBptGivenIn:
         *        If tokenIn is BPT: (exitSwap)
         *            Calculate amountOut with _calcTokenOutGivenExactBptIn; subtract amountOut from balances
         *        else: (joinSwap)
         *            Calculate BPTOut with _calcBptOutGivenExactTokensIn; add amountIn to balances
         *    StablePhantomPool._onSwapBptGivenOut:
         *        If tokenIn is BPT: (joinSwap)
         *            Calculate BPTIn with _calcBptInGivenExactTokensOut; subtract amountsOut from balances
         *       else: (exitSwap)
         *           Calculate amountIn with _calcTokenInGivenExactBptOut; add amountsIn to balances
         * 4) StablePhantomPool._updateInvariantAfterJoinExit:
         *        Using the post-swap balances calculated above
         *        _postJoinExitAmp = current amp
         *        _postJoinExitInvariant = calculate invariant using the current amp and post-swap balances
         *        Set oldRate = currentRate for any exempt tokens
         */
        context('BPT swaps', () => {
          // The cached amp and postJoinExit invariant will already be set from the pool initialization
          // So we want to test:
          // 1) If the first thing we do is a join or exit swap, there should be no protocol fees
          // 2) The amp and invariant should be set to the current values
          // 3) We should test both GivenIn and GivenOut, with the "other" token being 0 (no rate provider), and 1 (with rate provider)
          const NEW_AMP = AMPLIFICATION_PARAMETER.mul(3);
          const rateFactor = fp(1.1);
          let oldRate: BigNumber;

          sharedBeforeEach('start an amp change', async () => {
            const startTime = await currentTimestamp();
            const endTime = startTime.add(DAY * 2);

            await pool.startAmpChange(NEW_AMP, endTime);
          });

          function itPerformsABptSwapOnly(kind: SwapKind, tokenIndex: number) {
            it('performs a BPT swap as the first operation', async () => {
              // Advance time so that amp changes (should be reflected in postJoinExit invariant, which should be different from invariant before the operation)
              if (tokenIndex != tokenNoRateIndex) {
                // Change the rate before the operation
                oldRate = await rateProviders[tokenIndex].getRate();
                await rateProviders[tokenIndex].mockRate(
                  Math.random() > 0.5 ? oldRate.mul(rateFactor) : oldRate.div(rateFactor)
                );
              }
              // Do the swap, with the request set to BPT + token with the given index
              // Zero protocol fees, postJoinExits set properly
            });
          }

          function itPerformsABptSwapWithInterveningSwaps(kind: SwapKind, tokenIndex: number) {
            it('performs a BPT swap with intervening swaps', async () => {
              let oldRate: BigNumber;
              let newRate: BigNumber;

              // incur protocol fees - this changes the balances and ensures a different invariant
              // Advance time so that the amp changes
              if (tokenIndex != tokenNoRateIndex) {
                // Change the rate before the operation; may need the old one for fee calculation
                oldRate = await rateProviders[tokenIndex].getRate();
                newRate = Math.random() > 0.5 ? oldRate.mul(rateFactor) : oldRate.div(rateFactor);

                await rateProviders[tokenIndex].mockRate(newRate);
              }
              // Do the swap, with the request set to BPT + token with the given index
              // Protocol fees (using old rate and old amp, if exempt, or old amp and new rate otherwise)
              // postJoinExits set properly (current amp)
              // Verify that old rates are updated after the operation
            });
          }

          for (const kind of [SwapKind.GivenIn, SwapKind.GivenOut]) {
            for (const tokenIndex of [tokenNoRateIndex, tokenWithRateIndex, tokenWithRateExemptIndex]) {
              itPerformsABptSwapOnly(kind, tokenIndex);
            }
            for (const tokenIndex of [tokenNoRateIndex, tokenWithRateIndex, tokenWithRateExemptIndex]) {
              itPerformsABptSwapWithInterveningSwaps(kind, tokenIndex);
            }
          }
        });
      });

      /**
       * A join can be single token or "exact tokens in," either of which trigger protocol fee collection and caching.
       * A proportional join should pay no protocol fees.
       *
       * 1) StablePhantomPool.onJoinPool:
       *     update rates, if necessary (can set the duration to 0 so it will always update them)
       *     BasePool.onJoinPool:
       *         compute scaling factors, which includes both token decimals and rates
       *         Apply scaling factors to balances
       *         Call StablePhantomPool._onJoinPool to compute BPT amountOut and amountsIn; see #2
       *         mint BPTOut to recipient
       *         downscale and return amountsIn to the Vault
       * 2) StablePhantomPool._onJoinPool:
       *        Pay protocol fees (based on invariant growth)
       *        Check for one-token or multi-token:
       *        If multi-token, StablePhantomPool._joinExactTokensInForBPTOut:
       *            Apply scaling factors to amounts in (decimals and rates)
       *            Call _calcBptOutGivenExactTokensIn to compute BPT Out, and check limits passed in from caller
       *            Add amountsIn to compute post-join balances
       *        If one-token, StablePhantomPool._joinTokenInForExactBPTOut:
       *            Call _calcTokenInGivenExactBptOut to compute the amountIn
       *            Add amountsIn to compute post-join balances
       * 3) StablePhantomPool._updateInvariantAfterJoinExit:
       *        Using the post-join balances calculated above
       *        _postJoinExitAmp = current amp
       *        _postJoinExitInvariant = calculate invariant using the current amp and post-swap balances
       *        Set oldRate = currentRate for any exempt tokens
       */
      describe('joins', () => {
        const NEW_AMP = AMPLIFICATION_PARAMETER.mul(3);
        const rateFactor = fp(1.1);

        let scaledSwapAmounts: BigNumber[];
        let unscaledAmounts: BigNumberish[];
        const oldRates: BigNumber[] = [];
        const newRates: BigNumber[] = [];

        sharedBeforeEach('start an amp change', async () => {
          const startTime = await currentTimestamp();
          const endTime = startTime.add(DAY * 2);

          await pool.startAmpChange(NEW_AMP, endTime);
        });

        sharedBeforeEach('calculate join amounts', async () => {
          // These will be the "downscaled" raw input swap amounts
          scaledSwapAmounts = Array(tokens.length).fill(fp(10));
          unscaledAmounts = await pool.downscale(scaledSwapAmounts);
          console.log(`unscaled amounts: ${unscaledAmounts}`);
        });

        function itPerformsASingleTokenJoin(tokenIndex: number) {
          it(`calculates fees for single token joins with index ${tokenIndex}`, async () => {
            // Process a bunch of swaps (amp will also change during these)
            await incurProtocolFees();

            // Change all the rates (recall that 0 has no provider)
            oldRates[0] = fp(1);
            newRates[0] = fp(1);
            for (let i = 1; i < tokens.length; i++) {
              // Change the rate before the operation; may need the old one for fee calculation
              oldRates[i] = await rateProviders[i].getRate();
              newRates[i] = Math.random() > 0.5 ? oldRates[i].mul(rateFactor) : oldRates[i].div(rateFactor);

              await rateProviders[i].mockRate(newRates[i]);
            }

            // Do single token join with the given index
            // Check protocol fees (using oldRates/newRates, etc.)
            // Check updated amp/invariant values, and that oldRates have been updated
          });
        }

        for (const tokenIndex of [tokenNoRateIndex, tokenWithRateIndex, tokenWithRateExemptIndex]) {
          itPerformsASingleTokenJoin(tokenIndex);
        }

        function itPerformsAMultiTokenJoin(amountInRatios: number[]) {
          it('calculates fees for multi-token joins', async () => {
            console.log(`ratios: ${amountInRatios}`);
            // const amountsIn = scaledSwapAmounts.map((a, i) => a.mul(fp(amountInRatios[i])));
            // Do multi token join with the given amountsIn
            // Check protocol fees (using oldRates/newRates, etc.)
            // Check updated amp/invariant values, and that oldRates have been updated
          });
        }

        const unbalancedJoin = [0.8, 1.2, 2, 0.05, 0.45];
        const proportionalJoin = Array(5).fill(1);

        itPerformsAMultiTokenJoin(unbalancedJoin);
        // Should have no fees
        itPerformsAMultiTokenJoin(proportionalJoin);
      });

      /**
       * An exit can be single token or "exact tokens out," either of which trigger protocol fee collection and caching.
       * A proportional exit should pay no protocol fees.
       *
       * 1) StablePhantomPool.onExitPool:
       *     update rates, if necessary (can set the duration to 0 so it will always update them)
       *     BasePool.onExitPool:
       *         Check for recovery mode exit - if so, do that one instead
       *         compute scaling factors, which includes both token decimals and rates
       *         Apply scaling factors to balances
       *         Call StablePhantomPool._onExitPool to compute BPT amountIn and amountsOut; see #2
       *         burn BPTIn from sender
       *         downscale and return amountsOut to the Vault
       * 2) StablePhantomPool._onExitPool:
       *        Pay protocol fees (based on invariant growth)
       *        Check for one-token or multi-token:
       *        If multi-token, StablePhantomPool._exitBPTInForExactTokensOut:
       *            Apply scaling factors to amounts out (decimals and rates)
       *            Call _calcBptInGivenExactTokensOut to compute BPT In, and check limits passed in from caller
       *            Subtract amountsOut to compute post-exit balances
       *        If one-token, StablePhantomPool._exitExactBPTInForTokenOut:
       *            Call _calcTokenOutGivenExactBptIn to compute the amountOut
       *            Subtract amountsOut to compute post-exit balances
       * 3) StablePhantomPool._updateInvariantAfterJoinExit:
       *        Using the post-join balances calculated above
       *        _postJoinExitAmp = current amp
       *        _postJoinExitInvariant = calculate invariant using the current amp and post-swap balances
       *        Set oldRate = currentRate for any exempt tokens
       */
      describe('exits', () => {
        const NEW_AMP = AMPLIFICATION_PARAMETER.mul(3);
        const rateFactor = fp(1.1);

        let scaledSwapAmounts: BigNumber[];
        let unscaledAmounts: BigNumberish[];
        const oldRates: BigNumber[] = [];
        const newRates: BigNumber[] = [];

        sharedBeforeEach('start an amp change', async () => {
          const startTime = await currentTimestamp();
          const endTime = startTime.add(DAY * 2);

          await pool.startAmpChange(NEW_AMP, endTime);
        });

        sharedBeforeEach('calculate exit amounts', async () => {
          // These will be the "downscaled" raw input swap amounts
          scaledSwapAmounts = Array(tokens.length).fill(fp(10));
          unscaledAmounts = await pool.downscale(scaledSwapAmounts);
          console.log(`unscaled amounts: ${unscaledAmounts}`);
        });

        function itPerformsASingleTokenExit(tokenIndex: number) {
          it(`calculates fees for single token exits with token index ${tokenIndex}`, async () => {
            // Process a bunch of swaps (amp will also change during these)
            await incurProtocolFees();

            // Change all the rates (recall that 0 has no provider)
            oldRates[0] = fp(1);
            newRates[0] = fp(1);
            for (let i = 1; i < tokens.length; i++) {
              // Change the rate before the operation; may need the old one for fee calculation
              oldRates[i] = await rateProviders[i].getRate();
              newRates[i] = Math.random() > 0.5 ? oldRates[i].mul(rateFactor) : oldRates[i].div(rateFactor);

              await rateProviders[i].mockRate(newRates[i]);
            }

            // Do single token join with the given index
            // Check protocol fees (using oldRates/newRates, etc.)
            // Check updated amp/invariant values, and that oldRates have been updated
          });
        }

        for (const tokenIndex of [tokenNoRateIndex, tokenWithRateIndex, tokenWithRateExemptIndex]) {
          itPerformsASingleTokenExit(tokenIndex);
        }

        function itPerformsAMultiTokenExit(amountOutRatios: number[]) {
          it('calculates fees for multi-token joins', async () => {
            console.log(`amountOutRatios: ${amountOutRatios}`);
            // const amountsOut = scaledSwapAmounts.map((a, i) => a.mul(fp(amountOutRatios[i])));
            // Do multi token exit with the given amountsOut
            // Check protocol fees (using oldRates/newRates, etc.)
            // Check updated amp/invariant values, and that oldRates have been updated
          });
        }

        const unbalancedExit = [0.62, 1.08, 1.88, 0.25, 0.78];
        const proportionalExit = Array(5).fill(1);

        itPerformsAMultiTokenExit(unbalancedExit);
        // Should have no fees
        itPerformsAMultiTokenExit(proportionalExit);
      });
    });
  });

  function itBehavesAsStablePhantomPool(numberOfTokens: number): void {
    let pool: StablePhantomPool, tokens: TokenList;
    let deployTimestamp: BigNumber, bptIndex: number, initialBalances: BigNumberish[];

    const rateProviders: Contract[] = [];
    const tokenRateCacheDurations: number[] = [];
    const exemptFromYieldProtocolFeeFlags: boolean[] = [];

    const ZEROS = Array(numberOfTokens + 1).fill(bn(0));

    async function deployPool(
      params: RawStablePhantomPoolDeployment = {},
      rates: BigNumberish[] = [],
      durations: number[] = []
    ): Promise<void> {
      tokens = params.tokens || (await TokenList.create(numberOfTokens, { sorted: true }));

      for (let i = 0; i < numberOfTokens; i++) {
        rateProviders[i] = await deploy('v2-pool-utils/MockRateProvider');
        await rateProviders[i].mockRate(rates[i] || fp(1));
        tokenRateCacheDurations[i] = MONTH + i;
        exemptFromYieldProtocolFeeFlags[i] = i % 2 == 0; // set true for even tokens
      }

      pool = await StablePhantomPool.create({
        tokens,
        rateProviders,
        tokenRateCacheDurations: durations.length > 0 ? durations : tokenRateCacheDurations,
        exemptFromYieldProtocolFeeFlags,
        owner,
        admin,
        ...params,
      });

      bptIndex = await pool.getBptIndex();
      deployTimestamp = await currentTimestamp();
      initialBalances = Array.from({ length: numberOfTokens + 1 }).map((_, i) => (i == bptIndex ? 0 : fp(1 - i / 10)));
    }

    describe('creation', () => {
      context('when the creation succeeds', () => {
        const swapFeePercentage = fp(0.1);
        const tokenRates = Array.from({ length: numberOfTokens }, (_, i) => fp(1 + (i + 1) / 10));

        sharedBeforeEach('deploy pool', async () => {
          await deployPool({ swapFeePercentage, amplificationParameter: AMPLIFICATION_PARAMETER }, tokenRates);
        });

        it('sets the name', async () => {
          expect(await pool.name()).to.equal('Balancer Pool Token');
        });

        it('sets the symbol', async () => {
          expect(await pool.symbol()).to.equal('BPT');
        });

        it('sets the decimals', async () => {
          expect(await pool.decimals()).to.equal(18);
        });

        it('sets the owner ', async () => {
          expect(await pool.getOwner()).to.equal(owner.address);
        });

        it('sets the vault correctly', async () => {
          expect(await pool.getVault()).to.equal(pool.vault.address);
        });

        it('uses general specialization', async () => {
          const { address, specialization } = await pool.getRegisteredInfo();

          expect(address).to.equal(pool.address);
          expect(specialization).to.equal(PoolSpecialization.GeneralPool);
        });

        it('registers tokens in the vault', async () => {
          const { tokens: poolTokens, balances } = await pool.getTokens();

          expect(poolTokens).to.have.lengthOf(numberOfTokens + 1);
          expect(poolTokens).to.include.members(tokens.addresses);
          expect(poolTokens).to.include(pool.address);
          expect(balances).to.be.zeros;
        });

        it('starts with no BPT', async () => {
          expect(await pool.totalSupply()).to.be.equal(0);
        });

        it('sets swap fee', async () => {
          expect(await pool.getSwapFeePercentage()).to.equal(swapFeePercentage);
        });

        it('sets the rate cache durations', async () => {
          await tokens.asyncEach(async (token, i) => {
            const { duration, expires, rate } = await pool.getTokenRateCache(token);
            expect(rate).to.equal(tokenRates[i]);
            expect(duration).to.equal(tokenRateCacheDurations[i]);
            expect(expires).to.be.at.least(deployTimestamp.add(tokenRateCacheDurations[i]));
          });
        });

        it('reverts when querying rate cache for BPT', async () => {
          await expect(pool.getTokenRateCache(pool.address)).to.be.revertedWith('TOKEN_DOES_NOT_HAVE_RATE_PROVIDER');
        });

        it('reverts when updating the cache for BPT', async () => {
          await expect(pool.instance.updateTokenRateCache(pool.address)).to.be.revertedWith(
            'TOKEN_DOES_NOT_HAVE_RATE_PROVIDER'
          );
        });

        it('reverts when setting the cache duration for BPT', async () => {
          await expect(pool.instance.connect(owner).setTokenRateCacheDuration(pool.address, 0)).to.be.revertedWith(
            'TOKEN_DOES_NOT_HAVE_RATE_PROVIDER'
          );
        });
      });

      context('when the creation fails', () => {
        it('reverts if the cache durations do not match the tokens length', async () => {
          const tokenRateCacheDurations = [1];

          await expect(deployPool({ tokenRateCacheDurations })).to.be.revertedWith('INPUT_LENGTH_MISMATCH');
        });

        it('reverts if the swap fee is too high', async () => {
          const swapFeePercentage = fp(0.1).add(1);

          await expect(deployPool({ swapFeePercentage })).to.be.revertedWith('MAX_SWAP_FEE_PERCENTAGE');
        });
      });
    });

    describe('initialize', () => {
      sharedBeforeEach('deploy pool', async () => {
        await deployPool();
      });

      context('when not initialized', () => {
        context('when not paused', () => {
          it('transfers the initial balances to the vault', async () => {
            const previousBalances = await tokens.balanceOf(pool.vault);

            await pool.init({ initialBalances });

            const currentBalances = await tokens.balanceOf(pool.vault);
            currentBalances.forEach((currentBalance, i) => {
              const initialBalanceIndex = i < bptIndex ? i : i + 1; // initial balances includes BPT
              const expectedBalance = previousBalances[i].add(initialBalances[initialBalanceIndex]);
              expect(currentBalance).to.be.equal(expectedBalance);
            });
          });

          it('mints half the max amount of BPT minus minimum Bpt', async () => {
            await pool.init({ initialBalances });

            expect(await pool.totalSupply()).to.be.equalWithError(PREMINTED_BPT, 0.000000001);
          });

          it('mints the minimum BPT to the address zero', async () => {
            const minimumBpt = await pool.instance.getMinimumBpt();

            await pool.init({ recipient, initialBalances });

            expect(await pool.balanceOf(ZERO_ADDRESS)).to.be.equal(minimumBpt);
          });

          it('mints the invariant amount of BPT to the recipient', async () => {
            const invariant = await pool.estimateInvariant(initialBalances);
            const minimumBpt = await pool.instance.getMinimumBpt();

            await pool.init({ recipient, initialBalances, from: lp });

            expect(await pool.balanceOf(lp)).to.be.zero;
            expect(await pool.balanceOf(recipient)).to.be.equalWithError(invariant.sub(minimumBpt), 0.00001);
          });

          it('mints the rest of the BPT to the vault', async () => {
            const invariant = await pool.estimateInvariant(initialBalances);

            const { amountsIn, dueProtocolFeeAmounts } = await pool.init({ initialBalances });

            const expectedBPT = PREMINTED_BPT.sub(invariant);
            expect(await pool.balanceOf(pool.vault)).to.be.equalWithError(expectedBPT, 0.00001);

            expect(dueProtocolFeeAmounts).to.be.zeros;
            for (let i = 0; i < amountsIn.length; i++) {
              i === bptIndex
                ? expect(amountsIn[i]).to.be.equalWithError(PREMINTED_BPT.sub(invariant), 0.00001)
                : expect(amountsIn[i]).to.be.equal(initialBalances[i]);
            }
          });
        });

        context('when paused', () => {
          sharedBeforeEach('pause pool', async () => {
            await pool.pause();
          });

          it('reverts', async () => {
            await expect(pool.init({ initialBalances })).to.be.revertedWith('PAUSED');
          });
        });

        context('in recovery mode', () => {
          sharedBeforeEach('enable recovery mode', async () => {
            await pool.enableRecoveryMode(admin);
          });

          it('does not revert', async () => {
            await expect(pool.init({ initialBalances })).to.not.be.reverted;
          });
        });
      });

      context('when it was already initialized', () => {
        sharedBeforeEach('init pool', async () => {
          await pool.init({ initialBalances });
        });

        it('reverts', async () => {
          await expect(pool.init({ initialBalances })).to.be.revertedWith('UNHANDLED_JOIN_KIND');
        });
      });
    });

    describe('swap', () => {
      sharedBeforeEach('deploy pool', async () => {
        await deployPool();
      });

      context('when the pool was not initialized', () => {
        it('reverts', async () => {
          const tx = pool.swapGivenIn({ in: tokens.first, out: tokens.second, amount: fp(0), recipient });
          await expect(tx).to.be.reverted;
        });
      });

      context('when the pool was initialized', () => {
        sharedBeforeEach('initialize pool', async () => {
          bptIndex = await pool.getBptIndex();
          const sender = (await ethers.getSigners())[0];
          await pool.init({ initialBalances, recipient: sender });
        });

        sharedBeforeEach('allow vault', async () => {
          const sender = (await ethers.getSigners())[0];
          await tokens.mint({ to: sender, amount: fp(100) });
          await tokens.approve({ from: sender, to: pool.vault });
        });

        it('fails on a regular swap if caller is not the vault', async () => {
          const swapRequest = {
            kind: SwapKind.GivenIn,
            tokenIn: tokens.first.address,
            tokenOut: tokens.get(1).address,
            amount: fp(1),
            poolId: pool.poolId,
            lastChangeBlock: 0,
            from: lp.address,
            to: lp.address,
            userData: '0x',
          };

          await expect(pool.instance.connect(lp).onSwap(swapRequest, initialBalances, 0, 1)).to.be.revertedWith(
            'CALLER_NOT_VAULT'
          );
        });

        it('fails on a BPT swap if caller is not the vault', async () => {
          const swapRequest = {
            kind: SwapKind.GivenIn,
            tokenIn: tokens.first.address,
            tokenOut: pool.bpt.address,
            amount: fp(1),
            poolId: pool.poolId,
            lastChangeBlock: 0,
            from: lp.address,
            to: lp.address,
            userData: '0x',
          };

          await expect(pool.instance.connect(lp).onSwap(swapRequest, initialBalances, 0, 1)).to.be.revertedWith(
            'CALLER_NOT_VAULT'
          );
        });

        context('token out given token in', () => {
          const amountIn = fp(0.1);

          async function itSwapsTokensGivenIn(): Promise<void> {
            it('swaps tokens', async () => {
              const tokenIn = tokens.first;
              const tokenOut = tokens.second;

              const previousBalance = await tokenOut.balanceOf(recipient);
              const expectedAmountOut = await pool.estimateTokenOutGivenTokenIn(tokenIn, tokenOut, amountIn);

              const { amountOut } = await pool.swapGivenIn({ in: tokenIn, out: tokenOut, amount: amountIn, recipient });
              expect(amountOut).to.be.equalWithError(expectedAmountOut, 0.00001);

              const currentBalance = await tokenOut.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedAmountOut, 0.00001);
            });
          }

          itSwapsTokensGivenIn();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenIn({ in: tokens.first, out: tokens.second, amount: amountIn, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsTokensGivenIn();
          });
        });

        context('token in given token out', () => {
          const amountOut = fp(0.1);

          async function itSwapsTokensGivenOut(): Promise<void> {
            it('swaps tokens', async () => {
              const tokenIn = tokens.first;
              const tokenOut = tokens.second;

              const previousBalance = await tokenOut.balanceOf(recipient);
              const expectedAmountIn = await pool.estimateTokenInGivenTokenOut(tokenIn, tokenOut, amountOut);

              const { amountIn } = await pool.swapGivenOut({
                in: tokenIn,
                out: tokenOut,
                amount: amountOut,
                recipient,
              });
              expect(amountIn).to.be.equalWithError(expectedAmountIn, 0.00001);

              const currentBalance = await tokenOut.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equal(amountOut);
            });
          }

          itSwapsTokensGivenOut();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenOut({ in: tokens.first, out: tokens.second, amount: amountOut, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', async () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsTokensGivenOut();
          });
        });

        context('token out given BPT in', () => {
          const bptIn = fp(1);

          async function itSwapsTokenOutGivenBptIn(): Promise<void> {
            it('swaps exact BPT for token', async () => {
              const tokenOut = tokens.first;

              const previousBalance = await tokenOut.balanceOf(recipient);
              const expectedTokenOut = await pool.estimateTokenOutGivenBptIn(tokenOut, bptIn);

              const { amountOut } = await pool.swapGivenIn({ in: pool.bpt, out: tokenOut, amount: bptIn, recipient });
              expect(amountOut).to.be.equalWithError(expectedTokenOut, 0.00001);

              const currentBalance = await tokenOut.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedTokenOut, 0.00001);
            });
          }

          itSwapsTokenOutGivenBptIn();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenIn({ in: pool.bpt, out: tokens.first, amount: bptIn, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', async () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsTokenOutGivenBptIn();
          });
        });

        context('token in given BPT out', () => {
          const bptOut = fp(1);

          async function itSwapsTokenForExactBpt(): Promise<void> {
            it('swaps token for exact BPT', async () => {
              const tokenIn = tokens.first;

              const previousBalance = await pool.balanceOf(recipient);
              const expectedTokenIn = await pool.estimateTokenInGivenBptOut(tokenIn, bptOut);

              const { amountIn } = await pool.swapGivenOut({ in: tokenIn, out: pool.bpt, amount: bptOut, recipient });
              expect(amountIn).to.be.equalWithError(expectedTokenIn, 0.00001);

              const currentBalance = await pool.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equal(bptOut);
            });
          }

          itSwapsTokenForExactBpt();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenOut({ in: tokens.first, out: pool.bpt, amount: bptOut, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', async () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsTokenForExactBpt();
          });
        });

        context('BPT out given token in', () => {
          const amountIn = fp(1);

          async function itSwapsExactTokenForBpt(): Promise<void> {
            it('swaps exact token for BPT', async () => {
              const tokenIn = tokens.first;

              const previousBalance = await pool.balanceOf(recipient);
              const expectedBptOut = await pool.estimateBptOutGivenTokenIn(tokenIn, amountIn);

              const { amountOut } = await pool.swapGivenIn({ in: tokenIn, out: pool.bpt, amount: amountIn, recipient });
              expect(amountOut).to.be.equalWithError(expectedBptOut, 0.00001);

              const currentBalance = await pool.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedBptOut, 0.00001);
            });
          }

          itSwapsExactTokenForBpt();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenIn({ in: tokens.first, out: pool.bpt, amount: amountIn, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', async () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsExactTokenForBpt();
          });
        });

        context('BPT in given token out', () => {
          const amountOut = fp(0.1);

          async function itSwapsBptForExactTokens(): Promise<void> {
            it('swaps BPT for exact tokens', async () => {
              const tokenOut = tokens.first;

              const previousBalance = await tokenOut.balanceOf(recipient);
              const expectedBptIn = await pool.estimateBptInGivenTokenOut(tokenOut, amountOut);

              const { amountIn } = await pool.swapGivenOut({
                in: pool.bpt,
                out: tokenOut,
                amount: amountOut,
                recipient,
              });
              expect(amountIn).to.be.equalWithError(expectedBptIn, 0.00001);

              const currentBalance = await tokenOut.balanceOf(recipient);
              expect(currentBalance.sub(previousBalance)).to.be.equal(amountOut);
            });
          }

          itSwapsBptForExactTokens();

          context('when paused', () => {
            sharedBeforeEach('pause pool', async () => {
              await pool.pause();
            });

            it('reverts', async () => {
              await expect(
                pool.swapGivenOut({ in: pool.bpt, out: tokens.first, amount: amountOut, recipient })
              ).to.be.revertedWith('PAUSED');
            });
          });

          context('when in recovery mode', async () => {
            sharedBeforeEach('enable recovery mode', async () => {
              await pool.enableRecoveryMode(admin);
            });

            itSwapsBptForExactTokens();
          });
        });
      });
    });

    describe('onJoinPool', () => {
      sharedBeforeEach('deploy pool', async () => {
        await deployPool({ admin });
      });

      sharedBeforeEach('allow vault', async () => {
        await tokens.mint({ to: recipient, amount: fp(100) });
        await tokens.approve({ from: recipient, to: pool.vault });
      });

      it('fails if caller is not the vault', async () => {
        await expect(
          pool.instance.connect(lp).onJoinPool(pool.poolId, lp.address, other.address, [0], 0, 0, '0x')
        ).to.be.revertedWith('CALLER_NOT_VAULT');
      });

      it('fails if no user data', async () => {
        await expect(pool.join({ data: '0x' })).to.be.revertedWith('Transaction reverted without a reason');
      });

      it('fails if wrong user data', async () => {
        const wrongUserData = ethers.utils.defaultAbiCoder.encode(['address'], [lp.address]);

        await expect(pool.join({ data: wrongUserData })).to.be.revertedWith('Transaction reverted without a reason');
      });

      describe('join exact tokens in for BPT out', () => {
        context('not in recovery mode', () => {
          itJoinsGivenExactTokensInCorrectly();
        });

        context('in recovery mode', () => {
          sharedBeforeEach('enable recovery mode', async () => {
            await pool.enableRecoveryMode(admin);
          });

          itJoinsGivenExactTokensInCorrectly();
        });

        function itJoinsGivenExactTokensInCorrectly() {
          it('fails if not initialized', async () => {
            await expect(pool.joinGivenIn({ recipient, amountsIn: initialBalances })).to.be.revertedWith(
              'UNINITIALIZED'
            );
          });

          context('once initialized', () => {
            let expectedBptOut: BigNumberish;
            let amountsIn: BigNumberish[];

            sharedBeforeEach('initialize pool', async () => {
              await pool.init({ recipient, initialBalances });
              bptIndex = await pool.getBptIndex();
              amountsIn = ZEROS.map((n, i) => (i != bptIndex ? fp(0.1) : n));

              expectedBptOut = await pool.estimateBptOut(
                await pool.upscale(amountsIn),
                await pool.upscale(initialBalances)
              );
            });

            it('grants BPT for exact tokens', async () => {
              const previousBptBalance = await pool.balanceOf(recipient);
              const minimumBptOut = pct(expectedBptOut, 0.99);

              const result = await pool.joinGivenIn({ amountsIn, minimumBptOut, recipient, from: recipient });

              // Amounts in should be the same as initial ones
              expect(result.amountsIn).to.deep.equal(amountsIn);

              // Make sure received BPT is closed to what we expect
              const currentBptBalance = await pool.balanceOf(recipient);
              expect(currentBptBalance.sub(previousBptBalance)).to.be.equalWithError(expectedBptOut, 0.0001);
            });

            it('can tell how much BPT it will give in return', async () => {
              const minimumBptOut = pct(expectedBptOut, 0.99);

              const queryResult = await pool.queryJoinGivenIn({ amountsIn, minimumBptOut });

              expect(queryResult.amountsIn).to.deep.equal(amountsIn);
              expect(queryResult.bptOut).to.be.equalWithError(expectedBptOut, 0.0001);

              // Query and join should match exactly
              const result = await pool.joinGivenIn({ amountsIn, minimumBptOut, recipient, from: recipient });
              expect(result.amountsIn).to.deep.equal(queryResult.amountsIn);
            });

            it('fails if not enough BPT', async () => {
              // This call should fail because we are requesting minimum 1% more
              const minimumBptOut = pct(expectedBptOut, 1.01);

              await expect(pool.joinGivenIn({ amountsIn, minimumBptOut })).to.be.revertedWith('BPT_OUT_MIN_AMOUNT');
            });

            it('reverts if paused', async () => {
              await pool.pause();

              await expect(pool.joinGivenIn({ amountsIn })).to.be.revertedWith('PAUSED');
            });
          });
        }
      });

      describe('join token in for exact BPT out', () => {
        let tokenIndexWithBpt: number;
        let token: Token;

        sharedBeforeEach('get token to join with', async () => {
          // tokens are sorted, and do not include BPT, so get the last one
          const tokenIndexWithoutBpt = numberOfTokens - 1;
          token = tokens.get(tokenIndexWithoutBpt);
          tokenIndexWithBpt = tokenIndexWithoutBpt < pool.bptIndex ? tokenIndexWithoutBpt : tokenIndexWithoutBpt + 1;
        });

        context('not in recovery mode', () => {
          itJoinsExactBPTOutCorrectly();
        });

        context('in recovery mode', () => {
          sharedBeforeEach('enable recovery mode', async () => {
            await pool.enableRecoveryMode(admin);
          });

          itJoinsExactBPTOutCorrectly();
        });

        function itJoinsExactBPTOutCorrectly() {
          it('fails if not initialized', async () => {
            await expect(pool.joinGivenOut({ bptOut: fp(2), token })).to.be.revertedWith('UNINITIALIZED');
          });

          context('once initialized', () => {
            sharedBeforeEach('initialize pool', async () => {
              await pool.init({ recipient, initialBalances });
            });

            it('reverts if the tokenIndex passed in is invalid', async () => {
              const previousBptBalance = await pool.balanceOf(recipient);
              const bptOut = pct(previousBptBalance, 0.2);

              await expect(pool.joinGivenOut({ from: recipient, recipient, bptOut, token: 100 })).to.be.revertedWith(
                'OUT_OF_BOUNDS'
              );
            });

            it('grants exact BPT for token in', async () => {
              const previousBptBalance = await pool.balanceOf(recipient);
              // 20% of previous balance
              const bptOut = pct(previousBptBalance, 0.2);
              const expectedAmountIn = await pool.estimateTokenInGivenBptOut(token, bptOut);

              const result = await pool.joinGivenOut({ from: recipient, recipient, bptOut, token });

              // Only token in should be the one transferred
              expect(result.amountsIn[tokenIndexWithBpt]).to.be.equalWithError(expectedAmountIn, 0.001);
              expect(result.amountsIn.filter((_, i) => i != tokenIndexWithBpt)).to.be.zeros;

              // Make sure received BPT is close to what we expect
              const currentBptBalance = await pool.balanceOf(recipient);
              expect(currentBptBalance.sub(previousBptBalance)).to.be.equal(bptOut);
            });

            it('can tell how many tokens it will receive', async () => {
              const previousBptBalance = await pool.balanceOf(recipient);
              // 20% of previous balance
              const bptOut = pct(previousBptBalance, 0.2);

              const queryResult = await pool.queryJoinGivenOut({ recipient, bptOut, token });

              expect(queryResult.bptOut).to.be.equal(bptOut);
              expect(queryResult.amountsIn.filter((_, i) => i != tokenIndexWithBpt)).to.be.zeros;

              const result = await pool.joinGivenOut({ from: recipient, bptOut, token });
              // Query and join should match exactly
              expect(result.amountsIn[tokenIndexWithBpt]).to.equal(queryResult.amountsIn[tokenIndexWithBpt]);
            });

            it('join and joinSwap give the same result', async () => {
              const previousBptBalance = await pool.balanceOf(recipient);
              // 32.5% of previous balance
              const bptOut = pct(previousBptBalance, 0.325);

              const queryResult = await pool.queryJoinGivenOut({ recipient, bptOut, token });

              const amountIn = await pool.querySwapGivenOut({
                from: recipient,
                in: token,
                out: pool.bpt,
                amount: bptOut,
                recipient: lp,
              });

              expect(amountIn).to.be.equal(queryResult.amountsIn[tokenIndexWithBpt]);
            });

            it('reverts if paused', async () => {
              await pool.pause();

              await expect(pool.joinGivenOut({ bptOut: fp(2), token })).to.be.revertedWith('PAUSED');
            });
          });
        }
      });
    });

    describe('onExitPool', () => {
      let previousBptBalance: BigNumber;

      sharedBeforeEach('deploy and initialize pool', async () => {
        await deployPool({ admin });
        await pool.init({ initialBalances, recipient: lp });
        previousBptBalance = await pool.balanceOf(lp);
      });

      sharedBeforeEach('allow vault', async () => {
        await tokens.mint({ to: lp, amount: fp(100) });
        await tokens.approve({ from: lp, to: pool.vault });
      });

      it('fails if caller is not the vault', async () => {
        await expect(
          pool.instance.connect(lp).onExitPool(pool.poolId, recipient.address, other.address, [0], 0, 0, '0x')
        ).to.be.revertedWith('CALLER_NOT_VAULT');
      });

      it('fails if no user data', async () => {
        await expect(pool.exit({ data: '0x' })).to.be.revertedWith('Transaction reverted without a reason');
      });

      it('fails if wrong user data', async () => {
        const wrongUserData = ethers.utils.defaultAbiCoder.encode(['address'], [lp.address]);

        await expect(pool.exit({ data: wrongUserData })).to.be.revertedWith('Transaction reverted without a reason');
      });

      describe('exit BPT in for one token out', () => {
        let tokenIndexWithoutBpt: number;
        let tokenIndexWithBpt: number;
        let token: Token;

        sharedBeforeEach('get token to exit with', async () => {
          // tokens are sorted, and do not include BPT, so get the last one
          tokenIndexWithoutBpt = numberOfTokens - 1;
          token = tokens.get(tokenIndexWithoutBpt);
          tokenIndexWithBpt = tokenIndexWithoutBpt < pool.bptIndex ? tokenIndexWithoutBpt : tokenIndexWithoutBpt + 1;
        });

        context('not in recovery mode', () => {
          itExitsExactBptInForOneTokenOutProperly();
        });

        context('in recovery mode', () => {
          sharedBeforeEach('enable recovery mode', async () => {
            await pool.enableRecoveryMode(admin);
          });

          itExitsExactBptInForOneTokenOutProperly();
        });

        function itExitsExactBptInForOneTokenOutProperly() {
          it('reverts if the tokenIndex passed in is invalid', async () => {
            const previousBptBalance = await pool.balanceOf(lp);
            const bptIn = pct(previousBptBalance, 0.2);

            await expect(pool.singleExitGivenIn({ from: lp, bptIn, token: 100 })).to.be.revertedWith('OUT_OF_BOUNDS');
          });

          it('grants one token for exact bpt', async () => {
            // 20% of previous balance
            const previousBptBalance = await pool.balanceOf(lp);
            const bptIn = pct(previousBptBalance, 0.2);
            const expectedTokenOut = await pool.estimateTokenOutGivenBptIn(token, bptIn);

            const result = await pool.singleExitGivenIn({ from: lp, bptIn, token });

            // Only token out should be the one transferred
            expect(result.amountsOut[tokenIndexWithBpt]).to.be.equalWithError(expectedTokenOut, 0.0001);
            expect(result.amountsOut.filter((_, i) => i != tokenIndexWithBpt)).to.be.zeros;

            const bptAfter = await pool.balanceOf(lp);

            // Current BPT balance should decrease
            expect(previousBptBalance.sub(bptIn)).to.equal(bptAfter);
          });

          it('can tell how many tokens it will give in return', async () => {
            const bptIn = pct(await pool.balanceOf(lp), 0.2);
            const queryResult = await pool.querySingleExitGivenIn({ bptIn, token });

            expect(queryResult.bptIn).to.equal(bptIn);
            expect(queryResult.amountsOut.filter((_, i) => i != tokenIndexWithBpt)).to.be.zeros;

            const result = await pool.singleExitGivenIn({ from: lp, bptIn, token });
            expect(result.amountsOut.filter((_, i) => i != tokenIndexWithBpt)).to.be.zeros;

            // Query and exit should match exactly
            expect(result.amountsOut[tokenIndexWithBpt]).to.equal(queryResult.amountsOut[tokenIndexWithBpt]);
          });

          it('exit and exitSwap give the same result', async () => {
            const bptIn = pct(await pool.balanceOf(lp), 0.2);
            const queryResult = await pool.querySingleExitGivenIn({ bptIn, token });

            const amountOut = await pool.querySwapGivenIn({
              from: lp,
              in: pool.bpt,
              out: token,
              amount: bptIn,
              recipient: lp,
            });
            expect(queryResult.amountsOut[tokenIndexWithBpt]).to.equal(amountOut);
          });

          it('reverts if paused', async () => {
            await pool.pause();

            await expect(pool.singleExitGivenIn({ from: lp, bptIn: fp(1), token })).to.be.revertedWith('PAUSED');
          });
        }
      });

      describe('exit BPT in for exact tokens out', () => {
        context('not in recovery mode', () => {
          itExitsBptInForExactTokensOutProperly();
        });

        context('in recovery mode', () => {
          sharedBeforeEach('enable recovery mode', async () => {
            await pool.enableRecoveryMode(admin);
          });

          itExitsBptInForExactTokensOutProperly();
        });

        function itExitsBptInForExactTokensOutProperly() {
          it('grants exact tokens for bpt', async () => {
            // Request a third of the token balances
            const amountsOut = initialBalances.map((balance) => bn(balance).div(3));

            // Exit with a third of the BPT balance
            const expectedBptIn = previousBptBalance.div(3);
            const maximumBptIn = pct(expectedBptIn, 1.01);

            const result = await pool.exitGivenOut({ from: lp, amountsOut, maximumBptIn });

            // Token balances should been reduced as requested
            expect(result.amountsOut).to.deep.equal(amountsOut);

            // BPT balance should have been reduced to 2/3 because we are returning 1/3 of the tokens
            expect(await pool.balanceOf(lp)).to.be.equalWithError(previousBptBalance.sub(expectedBptIn), 0.001);
          });

          it('fails if more BPT needed', async () => {
            // Call should fail because we are requesting a max amount lower than the actual needed
            const amountsOut = initialBalances;
            const maximumBptIn = previousBptBalance.div(2);

            await expect(pool.exitGivenOut({ from: lp, amountsOut, maximumBptIn })).to.be.revertedWith(
              'BPT_IN_MAX_AMOUNT'
            );
          });

          it('can tell how much BPT it will have to receive', async () => {
            const amountsOut = initialBalances.map((balance) => bn(balance).div(2));
            const expectedBptIn = previousBptBalance.div(2);
            const maximumBptIn = pct(expectedBptIn, 1.01);

            const queryResult = await pool.queryExitGivenOut({ amountsOut, maximumBptIn });

            expect(queryResult.amountsOut).to.deep.equal(amountsOut);
            expect(queryResult.bptIn).to.be.equalWithError(previousBptBalance.div(2), 0.001);

            // Query and exit should match exactly
            const result = await pool.exitGivenOut({ from: lp, amountsOut, maximumBptIn });
            expect(result.amountsOut).to.deep.equal(queryResult.amountsOut);
          });

          it('reverts if paused', async () => {
            await pool.pause();

            const amountsOut = initialBalances;
            await expect(pool.exitGivenOut({ from: lp, amountsOut })).to.be.revertedWith('PAUSED');
          });
        }
      });
    });

    describe('rates cache', () => {
      context('with no rate provider', () => {
        sharedBeforeEach('deploy pool', async () => {
          const tokenParams = Array.from({ length: numberOfTokens }, (_, i) => ({ decimals: 18 - i }));
          tokens = await TokenList.create(tokenParams, { sorted: true, varyDecimals: true });

          pool = await StablePhantomPool.create({
            tokens,
            rateProviders: new Array(tokens.length).fill(ZERO_ADDRESS),
            tokenRateCacheDurations: new Array(tokens.length).fill(0),
            owner,
          });
        });

        it('has no rate providers', async () => {
          // length + 1 as there is also a rate provider for the BPT itself
          expect(await pool.getRateProviders()).to.deep.equal(new Array(tokens.length + 1).fill(ZERO_ADDRESS));
        });

        it('scaling factors equal the decimals difference', async () => {
          const { tokens } = await pool.vault.getPoolTokens(pool.poolId);

          await Promise.all(
            tokens.map(async (token) => {
              const decimals = await (await deployedAt('v2-solidity-utils/ERC20', token)).decimals();
              expect(await pool.instance.getScalingFactor(token)).to.equal(fp(bn(10).pow(18 - decimals)));
            })
          );
        });

        it('updating the cache reverts', async () => {
          await tokens.asyncEach(async (token) => {
            await expect(pool.updateTokenRateCache(token)).to.be.revertedWith('TOKEN_DOES_NOT_HAVE_RATE_PROVIDER');
          });
        });

        it('updating the cache duration reverts', async () => {
          await tokens.asyncEach(async (token) => {
            await expect(pool.setTokenRateCacheDuration(token, bn(0), { from: owner })).to.be.revertedWith(
              'TOKEN_DOES_NOT_HAVE_RATE_PROVIDER'
            );
          });
        });

        it('querying the cache reverts', async () => {
          await tokens.asyncEach(async (token) => {
            await expect(pool.getTokenRateCache(token)).to.be.revertedWith('TOKEN_DOES_NOT_HAVE_RATE_PROVIDER');
          });
        });
      });

      it('reverts when setting an exempt flag with no rate provider', async () => {
        const tokenParams = Array.from({ length: numberOfTokens }, (_, i) => ({ decimals: 18 - i }));
        tokens = await TokenList.create(tokenParams, { sorted: true, varyDecimals: true });

        await expect(
          StablePhantomPool.create({
            tokens,
            rateProviders: Array(tokens.length).fill(ZERO_ADDRESS),
            exemptFromYieldProtocolFeeFlags: Array(tokens.length).fill(true),
            tokenRateCacheDurations: new Array(tokens.length).fill(0),
            owner,
          })
        ).to.be.revertedWith('TOKEN_DOES_NOT_HAVE_RATE_PROVIDER');
      });

      const getExpectedScalingFactor = async (token: Token): Promise<BigNumber> => {
        const index = tokens.indexOf(token);
        const rateProvider = rateProviders[index];
        const rate = await rateProvider.getRate();
        return rate.mul(bn(10).pow(18 - token.decimals));
      };

      context('with a rate provider', () => {
        sharedBeforeEach('deploy pool', async () => {
          const tokenParams = Array.from({ length: numberOfTokens }, (_, i) => ({ decimals: 18 - i }));
          tokens = await TokenList.create(tokenParams, { sorted: true });

          const tokenRates = Array.from({ length: numberOfTokens }, (_, i) => fp(1 + (i + 1) / 10));
          await deployPool({ tokens }, tokenRates);
        });

        describe('scaling factors', () => {
          const itAdaptsTheScalingFactorsCorrectly = () => {
            it('adapt the scaling factors with the price rate', async () => {
              const scalingFactors = await pool.getScalingFactors();

              await tokens.asyncEach(async (token) => {
                const expectedScalingFactor = await getExpectedScalingFactor(token);
                const tokenIndex = await pool.getTokenIndex(token);
                expect(scalingFactors[tokenIndex]).to.be.equal(expectedScalingFactor);
                expect(await pool.getScalingFactor(token)).to.be.equal(expectedScalingFactor);
              });

              expect(scalingFactors[pool.bptIndex]).to.be.equal(fp(1));
              expect(await pool.getScalingFactor(pool.bpt)).to.be.equal(fp(1));
            });
          };

          context('with a price rate above 1', () => {
            sharedBeforeEach('mock rates', async () => {
              await tokens.asyncEach(async (token, i) => {
                await rateProviders[i].mockRate(fp(1 + i / 10));
                await pool.updateTokenRateCache(token);
              });
            });

            itAdaptsTheScalingFactorsCorrectly();
          });

          context('with a price rate equal to 1', () => {
            sharedBeforeEach('mock rates', async () => {
              await tokens.asyncEach(async (token, i) => {
                await rateProviders[i].mockRate(fp(1));
                await pool.updateTokenRateCache(token);
              });
            });

            itAdaptsTheScalingFactorsCorrectly();
          });

          context('with a price rate below 1', () => {
            sharedBeforeEach('mock rate', async () => {
              await tokens.asyncEach(async (token, i) => {
                await rateProviders[i].mockRate(fp(1 - i / 10));
                await pool.updateTokenRateCache(token);
              });
            });

            itAdaptsTheScalingFactorsCorrectly();
          });
        });

        describe('update', () => {
          const itUpdatesTheRateCache = (action: (token: Token) => Promise<ContractTransaction>) => {
            const newRate = fp(4.5);

            it('updates the cache', async () => {
              await tokens.asyncEach(async (token, i) => {
                const previousCache = await pool.getTokenRateCache(token);

                await rateProviders[i].mockRate(newRate);
                const updatedAt = await currentTimestamp();

                await action(token);

                const currentCache = await pool.getTokenRateCache(token);
                expect(currentCache.rate).to.be.equal(newRate);
                expect(previousCache.rate).not.to.be.equal(newRate);

                expect(currentCache.duration).to.be.equal(tokenRateCacheDurations[i]);
                expect(currentCache.expires).to.be.at.least(updatedAt.add(tokenRateCacheDurations[i]));
              });
            });

            it('emits an event', async () => {
              await tokens.asyncEach(async (token, i) => {
                await rateProviders[i].mockRate(newRate);
                const receipt = await action(token);

                expectEvent.inReceipt(await receipt.wait(), 'TokenRateCacheUpdated', {
                  rate: newRate,
                  token: token.address,
                });
              });
            });
          };

          context('before the cache expires', () => {
            sharedBeforeEach('advance time', async () => {
              await advanceTime(MINUTE);
            });

            context('when not forced', () => {
              const action = async (token: Token) => pool.instance.mockCacheTokenRateIfNecessary(token.address);

              it('does not update the cache', async () => {
                await tokens.asyncEach(async (token) => {
                  const previousCache = await pool.getTokenRateCache(token);

                  await action(token);

                  const currentCache = await pool.getTokenRateCache(token);
                  expect(currentCache.rate).to.be.equal(previousCache.rate);
                  expect(currentCache.expires).to.be.equal(previousCache.expires);
                  expect(currentCache.duration).to.be.equal(previousCache.duration);
                });
              });
            });

            context('when forced', () => {
              const action = async (token: Token) => pool.updateTokenRateCache(token);

              itUpdatesTheRateCache(action);
            });
          });

          context('after the cache expires', () => {
            sharedBeforeEach('advance time', async () => {
              await advanceTime(MONTH * 2);
            });

            context('when not forced', () => {
              const action = async (token: Token) => pool.instance.mockCacheTokenRateIfNecessary(token.address);

              itUpdatesTheRateCache(action);
            });

            context('when forced', () => {
              const action = async (token: Token) => pool.updateTokenRateCache(token);

              itUpdatesTheRateCache(action);
            });
          });
        });

        describe('set cache duration', () => {
          const newDuration = bn(MINUTE * 10);

          sharedBeforeEach('grant role to admin', async () => {
            const action = await actionId(pool.instance, 'setTokenRateCacheDuration');
            await pool.vault.grantPermissionsGlobally([action], admin);
          });

          const itUpdatesTheCacheDuration = () => {
            it('updates the cache duration', async () => {
              await tokens.asyncEach(async (token, i) => {
                const previousCache = await pool.getTokenRateCache(token);

                const newRate = fp(4.5);
                await rateProviders[i].mockRate(newRate);
                const forceUpdateAt = await currentTimestamp();
                await pool.setTokenRateCacheDuration(token, newDuration, { from: owner });

                const currentCache = await pool.getTokenRateCache(token);
                expect(currentCache.rate).to.be.equal(newRate);
                expect(previousCache.rate).not.to.be.equal(newRate);
                expect(currentCache.duration).to.be.equal(newDuration);
                expect(currentCache.expires).to.be.at.least(forceUpdateAt.add(newDuration));
              });
            });

            it('emits an event', async () => {
              await tokens.asyncEach(async (token, i) => {
                const tx = await pool.setTokenRateCacheDuration(token, newDuration, { from: owner });

                expectEvent.inReceipt(await tx.wait(), 'TokenRateProviderSet', {
                  token: token.address,
                  provider: rateProviders[i].address,
                  cacheDuration: newDuration,
                });
              });
            });
          };

          context('when it is requested by the owner', () => {
            context('before the cache expires', () => {
              sharedBeforeEach('advance time', async () => {
                await advanceTime(MINUTE);
              });

              itUpdatesTheCacheDuration();
            });

            context('after the cache has expired', () => {
              sharedBeforeEach('advance time', async () => {
                await advanceTime(MONTH * 2);
              });

              itUpdatesTheCacheDuration();
            });
          });

          context('when it is requested by the admin', () => {
            it('reverts', async () => {
              await expect(pool.setTokenRateCacheDuration(tokens.first, bn(10), { from: admin })).to.be.revertedWith(
                'SENDER_NOT_ALLOWED'
              );
            });
          });

          context('when it is requested by another one', () => {
            it('reverts', async () => {
              await expect(pool.setTokenRateCacheDuration(tokens.first, bn(10), { from: lp })).to.be.revertedWith(
                'SENDER_NOT_ALLOWED'
              );
            });
          });
        });

        describe('with upstream getRate failures', () => {
          const newRate = fp(4.5);

          sharedBeforeEach('set rate failure mode', async () => {
            await pool.setRateFailure(true);
          });

          it('reverts', async () => {
            await tokens.asyncEach(async (token, i) => {
              await rateProviders[i].mockRate(newRate);

              await expect(pool.updateTokenRateCache(token)).to.be.revertedWith('INDUCED_FAILURE');
            });
          });
        });
      });

      context('with a rate provider and zero durations', () => {
        sharedBeforeEach('deploy pool', async () => {
          const tokenParams = Array.from({ length: numberOfTokens }, (_, i) => ({ decimals: 18 - i }));
          tokens = await TokenList.create(tokenParams, { sorted: true });

          const tokenRates = Array.from({ length: numberOfTokens }, (_, i) => fp(1 + (i + 1) / 10));
          const durations = Array(tokens.length).fill(0);
          await deployPool({ tokens }, tokenRates, durations);
        });

        describe('when rates are updated between operations', () => {
          let previousScalingFactors: BigNumber[];
          let token: Token;
          let tokenIndexWithBpt: number;

          async function updateExternalRates(): Promise<void> {
            await tokens.asyncEach(async (token, i) => {
              const previousCache = await pool.getTokenRateCache(token);
              const value = Math.random() / 5;

              await rateProviders[i].mockRate(
                previousCache.rate.mul(Math.random() > 0.5 ? fp(1 + value) : fp(1 - value)).div(fp(1))
              );
            });
          }

          async function verifyScalingFactors(newScalingFactors: BigNumber[]): Promise<void> {
            await tokens.asyncEach(async (token) => {
              const expectedScalingFactor = await getExpectedScalingFactor(token);
              const tokenIndex = await pool.getTokenIndex(token);
              expect(newScalingFactors[tokenIndex]).to.be.equal(expectedScalingFactor);
              expect(await pool.getScalingFactor(token)).to.be.equal(expectedScalingFactor);
            });

            expect(newScalingFactors[pool.bptIndex]).to.be.equal(fp(1));
          }

          sharedBeforeEach('fund lp and pool', async () => {
            await tokens.mint({ to: lp, amount: fp(10000) });
            await tokens.approve({ from: lp, to: pool.vault });

            await pool.init({ initialBalances, recipient: lp });
          });

          sharedBeforeEach('save starting values and compute tokenIndex', async () => {
            previousScalingFactors = await pool.getScalingFactors();

            const tokenIndexWithoutBpt = numberOfTokens - 1;
            token = tokens.get(tokenIndexWithoutBpt);
            tokenIndexWithBpt = tokenIndexWithoutBpt < pool.bptIndex ? tokenIndexWithoutBpt : tokenIndexWithoutBpt + 1;
          });

          async function expectScalingFactorsToBeUpdated(
            query: () => Promise<BigNumberish>,
            actual: () => Promise<BigNumberish>
          ) {
            // Perform a query with the current rate values
            const queryAmount = await query();

            await updateExternalRates();

            // Verify the new rates are not yet loaded
            const preOpScalingFactors = await pool.getScalingFactors();
            for (let i = 0; i < preOpScalingFactors.length; i++) {
              if (i != pool.bptIndex) {
                expect(preOpScalingFactors[i]).to.equal(previousScalingFactors[i]);
              }
            }

            // Now we perform the actual operation - the result should be different. This must not be a query as we want
            // to check the updated state after the transaction.
            const actualAmount = await actual();

            // Verify the new rates are reflected in the scaling factors
            await verifyScalingFactors(await pool.getScalingFactors());

            expect(actualAmount).to.not.equal(queryAmount);
          }

          it('swaps use the new rates', async () => {
            const { balances, tokens: allTokens } = await pool.getTokens();
            const tokenIndex = allTokens.indexOf(tokens.first.address);

            const amountIn = balances[tokenIndex].div(5);

            const swapArgs = {
              in: tokens.first,
              out: tokens.second,
              amount: amountIn,
              from: lp,
              recipient: lp,
            };
            const query = () => pool.querySwapGivenIn(swapArgs);
            const actual = async () => (await pool.swapGivenIn(swapArgs)).amountOut;
            await expectScalingFactorsToBeUpdated(query, actual);
          });

          it('joins use the new rates', async () => {
            const previousBptBalance = await pool.balanceOf(lp);
            const bptOut = pct(previousBptBalance, 0.18);

            const query = async () =>
              (await pool.queryJoinGivenOut({ recipient: lp, bptOut, token })).amountsIn[tokenIndexWithBpt];
            const actual = async () =>
              (await pool.joinGivenOut({ from: lp, recipient: lp, bptOut, token })).amountsIn[tokenIndexWithBpt];

            await expectScalingFactorsToBeUpdated(query, actual);
          });

          it('exits use the new rates', async () => {
            const previousBptBalance = await pool.balanceOf(lp);
            const bptIn = pct(previousBptBalance, 0.082);

            const query = async () =>
              (await pool.querySingleExitGivenIn({ from: lp, bptIn, token })).amountsOut[tokenIndexWithBpt];
            const actual = async () =>
              (await pool.singleExitGivenIn({ from: lp, bptIn, token })).amountsOut[tokenIndexWithBpt];

            await expectScalingFactorsToBeUpdated(query, actual);
          });

          it('recovery mode exits do not update the cache', async () => {
            // Enter recovery mode
            await pool.enableRecoveryMode(admin);

            await updateExternalRates();

            // Verify the new rates are not yet loaded
            expect(await pool.getScalingFactors()).to.deep.equal(previousScalingFactors);

            // Do a recovery mode exit
            const { balances, tokens: allTokens } = await pool.getTokens();
            const bptIn = await pool.balanceOf(lp);

            await pool.recoveryModeExit({
              from: lp,
              tokens: allTokens,
              currentBalances: balances,
              bptIn,
            });

            // Verify the operation did NOT update the cache
            expect(await pool.getScalingFactors()).to.deep.equal(previousScalingFactors);
          });
        });
      });
    });

    describe.skip('protocol swap fees', () => {
      const swapFeePercentage = fp(0.1); // 10 %
      const protocolFeePercentage = fp(0.5); // 50 %
      let protocolFeesCollector: Contract;

      sharedBeforeEach('deploy pool', async () => {
        await deployPool({ swapFeePercentage });
        await pool.vault.setSwapFeePercentage(protocolFeePercentage);

        await pool.updateProtocolFeePercentageCache();

        protocolFeesCollector = await pool.vault.getFeesCollector();

        // Init pool with equal balances so that each BPT accounts for approximately one underlying token.
        const equalBalances = Array.from({ length: numberOfTokens + 1 }).map((_, i) => (i == bptIndex ? 0 : fp(100)));
        await pool.init({ recipient: lp.address, initialBalances: equalBalances });
      });

      sharedBeforeEach('allow vault', async () => {
        await tokens.mint({ to: lp, amount: fp(100) });
        await tokens.approve({ from: lp, to: pool.vault });
      });

      function itAccountsForProtocolFees() {
        describe('accounting', () => {
          const amount = fp(1);
          let inRecoveryMode: boolean;
          let previousBalance: BigNumber;

          sharedBeforeEach('update cache', async () => {
            await pool.updateProtocolFeePercentageCache();
            inRecoveryMode = await pool.inRecoveryMode();
          });

          enum AmountKind {
            WITH_FEE,
            WITHOUT_FEE,
          }

          function getExpectedProtocolFee(amount: BigNumber, kind: AmountKind, recoveryMode: boolean): BigNumber {
            // In StablePools, BPT and underlying tokens are almost equivalent. This means that the token fee amount is a
            // good estimate of the equivalent BPT fee amount.

            if (recoveryMode) {
              return bn(0);
            }

            if (kind == AmountKind.WITHOUT_FEE) {
              amount = amount.mul(fp(1)).div(fp(1).sub(swapFeePercentage));
            }

            const fee = amount.mul(swapFeePercentage).div(fp(1));
            const protocolFee = fee.mul(protocolFeePercentage).div(fp(1));
            return protocolFee;
          }

          context('on swaps given in', () => {
            sharedBeforeEach('ensure the initial protocol fee balance is non-zero', async () => {
              // Make the previousBalance non-zero
              await pool.swapGivenIn({
                in: tokens.second,
                out: pool.bpt,
                amount,
                from: lp,
                recipient: protocolFeesCollector.address,
              });
              previousBalance = await pool.balanceOf(protocolFeesCollector.address);
              expect(previousBalance).to.gt(0);
            });

            it('pays any protocol fees due when swapping tokens', async () => {
              await pool.swapGivenIn({ in: tokens.first, out: tokens.second, amount, from: lp, recipient });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(amount, AmountKind.WITH_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });

            it('pays any protocol fees due when swapping for BPT (join)', async () => {
              const { amountOut: bptAmount } = await pool.swapGivenIn({
                in: tokens.first,
                out: pool.bpt,
                amount,
                from: lp,
                recipient,
              });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(bptAmount, AmountKind.WITHOUT_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });

            it('pays any protocol fees due when swapping BPT (exit)', async () => {
              await pool.swapGivenIn({ in: pool.bpt, out: tokens.first, amount, from: lp, recipient });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(amount, AmountKind.WITHOUT_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });
          });

          context('on swaps given out', () => {
            sharedBeforeEach('ensure the initial protocol fee balance is non-zero', async () => {
              // Make the previousBalance non-zero
              await pool.swapGivenIn({
                in: tokens.second,
                out: pool.bpt,
                amount,
                from: lp,
                recipient: protocolFeesCollector.address,
              });
              previousBalance = await pool.balanceOf(protocolFeesCollector.address);
              expect(previousBalance).to.gt(0);
            });

            it('pays any protocol fees due when swapping tokens', async () => {
              const { amountIn } = await pool.swapGivenOut({
                in: tokens.first,
                out: tokens.second,
                amount,
                from: lp,
                recipient,
              });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(amountIn, AmountKind.WITH_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });

            it('pays any protocol fees due when swapping for BPT (join)', async () => {
              await pool.swapGivenOut({ in: tokens.first, out: pool.bpt, amount, from: lp, recipient });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(amount, AmountKind.WITHOUT_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });

            it('pays any protocol fees due when swapping BPT (exit)', async () => {
              const { amountIn: bptAmount } = await pool.swapGivenOut({
                in: pool.bpt,
                out: tokens.first,
                amount,
                from: lp,
                recipient,
              });

              const currentBalance = await pool.balanceOf(protocolFeesCollector.address);
              const expectedFee = getExpectedProtocolFee(bptAmount, AmountKind.WITHOUT_FEE, inRecoveryMode);

              expect(currentBalance.sub(previousBalance)).to.be.equalWithError(expectedFee, 0.01);
            });
          });
        });
      }

      context('not in recovery mode', () => {
        itAccountsForProtocolFees();
      });

      context('in recovery mode', () => {
        sharedBeforeEach('enter recovery mode', async () => {
          await pool.enableRecoveryMode(admin);
        });

        itAccountsForProtocolFees();
      });

      it('proportional join should collect no protocol fee', async () => {
        const feeCollectorBalanceBefore = await pool.balanceOf(protocolFeesCollector);
        expect(feeCollectorBalanceBefore).to.equal(bn(0));

        const amountsIn: BigNumber[] = ZEROS.map((n, i) => (i != bptIndex ? fp(1) : n));
        await pool.joinGivenIn({ amountsIn, minimumBptOut: pct(fp(numberOfTokens), 0.9999), recipient: lp, from: lp });

        const feeCollectorBalanceAfter = await pool.balanceOf(protocolFeesCollector);
        expect(feeCollectorBalanceAfter).to.be.zero;
      });
    });

    describe('virtual supply', () => {
      let equalBalances: BigNumber[];
      const swapFeePercentage = fp(0.1); // 10 %
      const protocolFeePercentage = fp(0.5); // 50 %

      sharedBeforeEach('deploy pool', async () => {
        await deployPool({ swapFeePercentage });
        await pool.vault.setSwapFeePercentage(protocolFeePercentage);

        await pool.updateProtocolFeePercentageCache();

        // Init pool with equal balances so that each BPT accounts for approximately one underlying token.
        equalBalances = Array.from({ length: numberOfTokens + 1 }).map((_, i) => (i == bptIndex ? bn(0) : fp(100)));
        await pool.init({ recipient: lp.address, initialBalances: equalBalances });
      });

      context('without protocol fees', () => {
        it('reports correctly', async () => {
          const senderBptBalance = await pool.balanceOf(lp);

          const virtualSupply = await pool.getVirtualSupply();

          expect(virtualSupply).to.be.equalWithError(senderBptBalance, 0.0001);
        });
      });

      context.skip('with protocol fees', () => {
        const amount = fp(50);

        sharedBeforeEach('swap bpt in', async () => {
          const tokenIn = pool.bpt;
          const tokenOut = tokens.second;

          await tokens.mint({ to: lp, amount });
          await tokens.approve({ from: lp, to: pool.vault });

          await pool.swapGivenIn({ in: tokenIn, out: tokenOut, amount, from: lp, recipient });
        });

        it('reports correctly', async () => {
          const amountWithFee = amount.mul(fp(1)).div(fp(1).sub(swapFeePercentage));
          const fee = amountWithFee.mul(swapFeePercentage).div(fp(1));
          const protocolFee = fee.mul(protocolFeePercentage).div(fp(1));

          const senderBptBalance = await pool.balanceOf(lp);

          const virtualSupply = await pool.getVirtualSupply();

          expect(virtualSupply).to.be.equalWithError(senderBptBalance.add(protocolFee), 0.0001);
        });
      });
    });

    describe('getRate', () => {
      const swapFeePercentage = fp(0.1); // 10 %
      const protocolFeePercentage = fp(0.5); // 50 %

      sharedBeforeEach('deploy pool', async () => {
        await deployPool({ swapFeePercentage });
        await pool.vault.setSwapFeePercentage(protocolFeePercentage);

        await pool.updateProtocolFeePercentageCache();
      });

      context('before initialized', () => {
        it('rate is zero', async () => {
          await expect(pool.getRate()).to.be.revertedWith('ZERO_DIVISION');
        });
      });

      context('once initialized', () => {
        sharedBeforeEach('initialize pool', async () => {
          // Init pool with equal balances so that each BPT accounts for approximately one underlying token.
          const equalBalances = Array.from({ length: numberOfTokens + 1 }).map((_, i) =>
            i == bptIndex ? bn(0) : fp(100)
          );
          await pool.init({ recipient: lp.address, initialBalances: equalBalances });
        });

        context('without protocol fees', () => {
          it('reports correctly', async () => {
            const virtualSupply = await pool.getVirtualSupply();
            const invariant = await pool.estimateInvariant();

            const expectedRate = invariant.mul(FP_SCALING_FACTOR).div(virtualSupply);

            const rate = await pool.getRate();

            expect(rate).to.be.equalWithError(expectedRate, 0.0001);
          });
        });

        context('with protocol fees', () => {
          sharedBeforeEach('swap bpt in', async () => {
            const amount = fp(50);
            const tokenIn = pool.bpt;
            const tokenOut = tokens.second;

            await tokens.mint({ to: lp, amount });
            await tokens.approve({ from: lp, to: pool.vault });

            await pool.swapGivenIn({ in: tokenIn, out: tokenOut, amount, from: lp, recipient });
          });

          it('reports correctly', async () => {
            const virtualSupply = await pool.getVirtualSupply();
            const invariant = await pool.estimateInvariant();

            const expectedRate = invariant.mul(FP_SCALING_FACTOR).div(virtualSupply);

            const rate = await pool.getRate();

            expect(rate).to.be.equalWithError(expectedRate, 0.0001);
          });
        });
      });
    });

    describe('recovery mode', () => {
      let sender: SignerWithAddress;
      let allTokens: string[];

      sharedBeforeEach('deploy pool', async () => {
        await deployPool();
        sender = (await ethers.getSigners())[0];

        const equalBalances = Array.from({ length: numberOfTokens + 1 }).map((_, i) =>
          i == bptIndex ? bn(0) : fp(100)
        );
        await pool.init({ recipient: sender, initialBalances: equalBalances });

        const result = await pool.getTokens();
        allTokens = result.tokens;
      });

      context('when not in recovery mode', () => {
        it('reverts', async () => {
          const totalBptBalance = await pool.balanceOf(lp);

          await expect(
            pool.recoveryModeExit({
              from: lp,
              tokens: allTokens,
              currentBalances: initialBalances,
              bptIn: totalBptBalance,
            })
          ).to.be.revertedWith('NOT_IN_RECOVERY_MODE');
        });
      });

      context('when in recovery mode', () => {
        sharedBeforeEach('enable recovery mode', async () => {
          await pool.enableRecoveryMode(admin);
        });

        context('one lp', () => {
          it('can partially exit', async () => {
            const previousVirtualSupply = await pool.getVirtualSupply();
            const previousSenderBptBalance = await pool.balanceOf(sender);

            //Exit with 1/4 of BPT balance
            const bptIn = (await pool.balanceOf(sender)).div(4);

            const currentBalances = await pool.getBalances();
            const expectedAmountsOut = currentBalances.map((balance, i) =>
              i == pool.bptIndex ? bn(0) : bn(balance).mul(previousSenderBptBalance).div(previousVirtualSupply).div(4)
            );

            const result = await pool.recoveryModeExit({
              from: sender,
              tokens: allTokens,
              currentBalances: initialBalances,
              bptIn,
            });

            expect(result.amountsOut).to.be.equalWithError(expectedAmountsOut, 0.00001);

            const currentSenderBptBalance = await pool.balanceOf(sender);
            expect(previousSenderBptBalance.sub(currentSenderBptBalance)).to.be.equalWithError(bptIn, 0.00001);

            // Current virtual supply
            const currentVirtualSupply = await pool.getVirtualSupply();
            expect(currentVirtualSupply).to.be.equalWithError(previousVirtualSupply.sub(bptIn), 0.00001);
          });
        });

        context('two lps', () => {
          const amount = fp(100);

          sharedBeforeEach('second lp swaps', async () => {
            await tokens.mint({ to: lp, amount });
            await tokens.approve({ from: lp, to: pool.vault });
            await pool.swapGivenIn({
              in: tokens.first,
              out: pool.bpt,
              amount: amount,
              from: lp,
              recipient: lp,
            });
          });

          async function itAllowsBothLpsToExit(): Promise<void> {
            sharedBeforeEach('first lp exits', async () => {
              const bptIn = await pool.balanceOf(sender);

              await pool.recoveryModeExit({
                from: sender,
                tokens: allTokens,
                currentBalances: initialBalances,
                bptIn,
              });
            });

            it('can fully exit proportionally', async () => {
              const previousVirtualSupply = await pool.getVirtualSupply();
              const previousLpBptBalance = await pool.balanceOf(lp);

              const currentBalances = await pool.getBalances();
              const expectedAmountsOut = currentBalances.map((balance, i) =>
                i == pool.bptIndex ? bn(0) : bn(balance).mul(previousLpBptBalance).div(previousVirtualSupply)
              );

              //Exit with all BPT balance
              const result = await pool.recoveryModeExit({
                from: lp,
                tokens: allTokens,
                currentBalances,
                bptIn: previousLpBptBalance,
              });

              expect(result.amountsOut).to.be.equalWithError(expectedAmountsOut, 0.00001);

              const currentLpBptBalance = await pool.balanceOf(lp);
              expect(currentLpBptBalance).to.be.equal(0);

              // Current virtual supply after full exit is the minted minimumBpt to 0x0
              const minimumBpt = await pool.instance.getMinimumBpt();
              const currentVirtualSupply = await pool.getVirtualSupply();
              expect(currentVirtualSupply).to.be.equalWithError(minimumBpt, 0.00001);
            });
          }

          context('with functioning pool', () => {
            itAllowsBothLpsToExit();
          });

          context('with broken pool', () => {
            sharedBeforeEach('blow up pool', async () => {
              await pool.setInvariantFailure(true);
              await pool.setRateFailure(true);
            });

            it('verify invariant-dependent and external rate calls fail', async () => {
              await expect(pool.getRate()).to.be.revertedWith('INDUCED_FAILURE');
              await expect(pool.instance.getTokenRate(tokens.first.address)).to.be.revertedWith('INDUCED_FAILURE');
            });

            itAllowsBothLpsToExit();
          });
        });
      });
    });
  }
});
