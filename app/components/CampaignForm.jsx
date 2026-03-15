import {
  forwardRef,
  useImperativeHandle,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import { Form, useFetcher } from "@remix-run/react";
import {
  Card,
  FormLayout,
  TextField,
  Button,
  Text,
  BlockStack,
  Grid,
  Spinner,
  Autocomplete,
  InlineError,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Icon,
  ButtonGroup,
  List,
  Tooltip, // ✨ Import the Tooltip component
} from '@shopify/polaris';
import { toDate, formatInTimeZone } from 'date-fns-tz';
import { addMinutes } from 'date-fns';
import { DeleteIcon, PlusIcon, ImageIcon } from '@shopify/polaris-icons';
import { validateTiers } from './validation';
import { DateTimePicker } from './DateTimePicker';

export const CampaignForm = forwardRef(({
  initialData = {},
  isFinished,
  hasParticipants,
  formErrors = {},
  onDirtyChange = () => { },
  onValidityChange = () => { },
  translations = {}
}, ref) => {
  const formRef = useRef(null);
  const hasUserInteracted = useRef(false);
  const isInitialMount = useRef(true);

  const [initialFormState, setInitialFormState] = useState(() => ({
    startDate: initialData.startDateTime || null,
    endDate: initialData.endDateTime || null,
    tiers: initialData.tiersJson ? JSON.parse(initialData.tiersJson) : [{ quantity: '5', discount: '10' }],
    leaderDiscount: initialData.leaderDiscount?.toString() || '0',
    startingParticipants: initialData.startingParticipants?.toString() || '0',
    timezone: initialData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  const [startDate, setStartDate] = useState(initialFormState.startDate);
  const [endDate, setEndDate] = useState(initialFormState.endDate);
  const [timezone, setTimezone] = useState(initialFormState.timezone);
  const [tiers, setTiers] = useState(initialFormState.tiers);
  const [leaderDiscount, setLeaderDiscount] = useState(initialFormState.leaderDiscount);
  const [startingParticipants, setStartingParticipants] = useState(initialFormState.startingParticipants);
  const [minStartDateTime, setMinStartDateTime] = useState(new Date());
  const [liveTime, setLiveTime] = useState(new Date());

  const [selectedProducts, setSelectedProducts] = useState(initialData.selectedProducts || []);

  const [scope, setScope] = useState(
    initialData.scope || 'PRODUCT'
  );
  const [countingMethod, setCountingMethod] = useState(
    initialData.countingMethod || 'PARTICIPANT'
  );

  const productFetcher = useFetcher();
  const [clientPickerError, setClientPickerError] = useState(null);
  const [timezoneInputValue, setTimezoneInputValue] = useState(initialFormState.timezone.replace(/_/g, ' '));
  const [filteredTimezoneOptions, setFilteredTimezoneOptions] = useState([]);
  const [tierErrors, setTierErrors] = useState([]);

  const isStarted = startDate ? new Date(startDate) < liveTime : false;

  useEffect(() => {
    const timer = setInterval(() => setLiveTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const now = new Date();
    const newMinStartTime = new Date(now.getTime());
    const currentMinutes = newMinStartTime.getMinutes();
    const remainder = currentMinutes % 10;
    newMinStartTime.setMinutes(currentMinutes + (10 - remainder), 0, 0);

    setMinStartDateTime(newMinStartTime);
  }, [liveTime]);

  useEffect(() => {
    if (initialData.id || !timezone) return;

    if (!startDate) {
      let startTime = new Date();
      const currentMinutes = startTime.getMinutes();
      const remainder = currentMinutes % 10;
      startTime.setMinutes(currentMinutes + (10 - remainder), 0, 0);

      const startISO = startTime.toISOString();
      setStartDate(startISO);

      const endTime = addMinutes(startTime, 10);
      const endISO = endTime.toISOString();
      setEndDate(endISO);

      setInitialFormState(prev => ({ ...prev, startDate: startISO, endDate: endISO }));
    }
  }, [initialData.id, startDate, timezone]);

  useEffect(() => {
    if (!startDate || !endDate) return;

    const startDateObj = toDate(startDate);
    const endDateObj = toDate(endDate);

    if (endDateObj <= startDateObj) {
      const newEndDate = addMinutes(startDateObj, 10);
      setEndDate(newEndDate.toISOString());
    }
  }, [startDate]);

  const onValueChange = (setter) => (value) => {
    hasUserInteracted.current = true;
    setter(value);
  };

  useEffect(() => {
    if (!hasUserInteracted.current) {
      onDirtyChange(false);
      return;
    }
    const hasChanged =
      startDate !== initialFormState.startDate ||
      endDate !== initialFormState.endDate ||
      JSON.stringify(tiers) !== JSON.stringify(initialFormState.tiers) ||
      leaderDiscount !== initialFormState.leaderDiscount ||
      startingParticipants !== initialFormState.startingParticipants ||
      timezone !== initialFormState.timezone ||
      JSON.stringify(selectedProducts) !== JSON.stringify(initialData.selectedProducts || []) ||
      scope !== (initialData.scope || 'PRODUCT') ||
      countingMethod !== (initialData.countingMethod || 'PARTICIPANT');

    const isReadyTosave = hasChanged && productFetcher.state !== 'loading';
    onDirtyChange(isReadyTosave);

  }, [startDate, endDate, tiers, leaderDiscount, startingParticipants, timezone, selectedProducts, initialFormState, initialData, onDirtyChange, productFetcher.state, scope, countingMethod]);

  useImperativeHandle(ref, () => ({
    submit: () => formRef.current?.requestSubmit(),
    discard: () => {
      hasUserInteracted.current = false;
      setStartDate(initialFormState.startDate);
      setEndDate(initialFormState.endDate);
      setTiers(initialFormState.tiers);
      setLeaderDiscount(initialFormState.leaderDiscount);
      setStartingParticipants(initialFormState.startingParticipants);
      setTimezone(initialFormState.timezone);
      setSelectedProducts(initialData.selectedProducts || []);
      setScope(initialData.scope || 'PRODUCT');
      setCountingMethod(initialData.countingMethod || 'PARTICIPANT');
      setTimezoneInputValue(initialFormState.timezone.replace(/_/g, ' '));
    },
  }));

  useEffect(() => {
    const newTierErrors = validateTiers(tiers);
    setTierErrors(newTierErrors);
    const isProductSelected = selectedProducts.length > 0;
    const areTiersValid = newTierErrors.every(e => !e || Object.keys(e).length === 0);
    const areDatesValid = startDate && endDate && new Date(startDate) < new Date(endDate);
    const discountNum = parseInt(leaderDiscount, 10);
    const isDiscountValid = !isNaN(discountNum) && discountNum >= 0 && discountNum <= 100;
    onValidityChange(isProductSelected && areTiersValid && areDatesValid && isDiscountValid);
  }, [tiers, startDate, endDate, leaderDiscount, selectedProducts, onValidityChange]);

  const allTimezoneOptions = useMemo(() => Intl.supportedValuesOf('timeZone').map((tz) => ({ value: tz, label: tz.replace(/_/g, ' ') })), []);
  useEffect(() => { setFilteredTimezoneOptions(allTimezoneOptions) }, [allTimezoneOptions]);

  useEffect(() => {
    if (productFetcher.data) {
      const { hasActiveCampaign, isDiscounted } = productFetcher.data;

      if (hasActiveCampaign || isDiscounted) {
        const message = hasActiveCampaign
          ? "This product already has an active campaign."
          : "Discounted products cannot be used.";

        setClientPickerError(message);
        setSelectedProducts([]);
        onDirtyChange(false);
      } else {
        setClientPickerError(null);
      }
    }
  }, [productFetcher.data, onDirtyChange]);

  const handleTimezoneInputChange = (value) => { setTimezoneInputValue(value); setFilteredTimezoneOptions(value === '' ? allTimezoneOptions : allTimezoneOptions.filter((o) => o.label.match(new RegExp(value, 'i')))); };
  const handleSelectTimezone = (selected) => { const tz = selected[0]; onValueChange(setTimezone)(tz); setTimezoneInputValue(allTimezoneOptions.find(o => o.value === tz)?.label || tz); };

  const handleProductSelection = async () => {
    if (!window.shopify?.resourcePicker) {
      setClientPickerError("Shopify Resource Picker not available.");
      return;
    }
    try {
      const selection = await window.shopify.resourcePicker({
        type: "product",
        multiple: 1,
      });

      if (selection) {
        const firstProductId = selection[0].id;
        const allFromSameProduct = selection.every(
          (item) => item.id === firstProductId
        );

        if (!allFromSameProduct) {
          setClientPickerError("Please select variants from only one product.");
          return;
        }

        setClientPickerError(null);

        const allSelectedVariants = selection.flatMap(product =>
          product.variants.map(variant => ({
            id: product.id,
            variantId: variant.id,
            title: product.title,
            variantTitle: variant.title,
            image: variant.image?.originalSrc || product.images[0]?.originalSrc || '',
            handle: product.handle
          }))
        );

        onValueChange(setSelectedProducts)(allSelectedVariants);

        if (selection.length > 0) {
          productFetcher.load(`/api/validate-product?id=${selection[0].id}`);
        }
      }
    } catch (error) {
      console.error("Resource picker error:", error);
      setClientPickerError(`Picker failed: ${error.message}`);
    }
  };

  const handleTierChange = (index, field, value) => { onValueChange(setTiers)(currentTiers => { const newTiers = [...currentTiers]; const sanitized = value.replace(/[^\d]/g, ''); let numericValue = sanitized === '' ? '' : parseInt(sanitized, 10); if (field === 'discount' && numericValue > 100) numericValue = 100; newTiers[index] = { ...newTiers[index], [field]: numericValue.toString() }; return newTiers; }); };
  const handleAddTier = () => { onValueChange(setTiers)(currentTiers => [...currentTiers, { quantity: '', discount: '' }]); };
  const handleRemoveTier = (index) => { onValueChange(setTiers)(currentTiers => currentTiers.filter((_, i) => i !== index)); };
  const handleNumericChange = (setter) => (value) => { const sanitized = value.replace(/[^\d]/g, ''); onValueChange(setter)(sanitized === '' ? '0' : parseInt(sanitized, 10).toString()); };
  const handleRemoveVariant = (variantIdToRemove) => {
    onValueChange(setSelectedProducts)((prevProducts) =>
      prevProducts.filter((product) => product.variantId !== variantIdToRemove)
    );
  };

  const minEndDateTime = useMemo(() => {
    if (!startDate) return null;
    let minDate = toDate(startDate);
    const [startHour, startMinute] = formatInTimeZone(minDate, timezone, 'HH:mm').split(':').map(Number);
    if (startHour === 23 && startMinute === 10) {
      minDate = addMinutes(minDate, 10);
    }
    return minDate;
  }, [startDate, timezone]);

  const isEndDateInclusive = useMemo(() => {
    if (!startDate || !endDate) return true;
    const startDateStr = formatInTimeZone(toDate(startDate), timezone, 'yyyy-MM-dd');
    const endDateStr = formatInTimeZone(toDate(endDate), timezone, 'yyyy-MM-dd');
    return startDateStr !== endDateStr;
  }, [startDate, endDate, timezone]);

  const leaderDiscountSwitchRef = useRef(null);
  const startingParticipantsSwitchRef = useRef(null);

  const [leaderDiscountEnabled, setLeaderDiscountEnabled] = useState(() => parseInt(initialFormState.leaderDiscount, 10) > 0);
  const [startingParticipantsEnabled, setStartingParticipantsEnabled] = useState(() => parseInt(initialFormState.startingParticipants, 10) > 0);

  const handleLeaderDiscountToggle = (event) => {
    const isChecked = event.currentTarget.checked;
    setLeaderDiscountEnabled(isChecked);
    if (isChecked) setStartingParticipantsEnabled(false);
  };

  const handleStartingParticipantsToggle = (event) => {
    const isChecked = event.currentTarget.checked;
    setStartingParticipantsEnabled(isChecked);
    if (isChecked) setLeaderDiscountEnabled(false);
  };

  const handleLeaderDiscountChange = (value) => {
    const sanitized = value.replace(/[^\d]/g, '');
    let numericValue = sanitized === '' ? 0 : parseInt(sanitized, 10);
    if (numericValue > 100) numericValue = 100;
    onValueChange(setLeaderDiscount)(numericValue.toString());
  };

  useEffect(() => {
    setTimeout(() => {
      if (leaderDiscountSwitchRef.current) leaderDiscountSwitchRef.current.checked = leaderDiscountEnabled;
    }, 0);
  }, [leaderDiscountEnabled]);

  useEffect(() => {
    setTimeout(() => {
      if (startingParticipantsSwitchRef.current) startingParticipantsSwitchRef.current.checked = startingParticipantsEnabled;
    }, 0);
  }, [startingParticipantsEnabled]);

  const pickerError = formErrors?.product || clientPickerError;
  const isEditing = !!initialData.id;

  const tierLabel = countingMethod === 'PARTICIPANT' 
    ? (translations?.sections?.tiers?.countBuyers || 'Min. participants') 
    : (translations?.sections?.tiers?.countItems || 'Min. items sold');

  const startingCountLabel = countingMethod === 'PARTICIPANT'
    ? (translations?.sections?.features?.startingParticipantsLabel || 'Starting participants (fake count)')
    : (translations?.sections?.features?.startingItemsLabel || 'Starting items sold (fake count)');

  const startingCountDetails = countingMethod === 'PARTICIPANT'
    ? (translations?.sections?.features?.startingParticipantsDetails || 'Sets a starting number of participants to make the group buy look more popular')
    : (translations?.sections?.features?.startingItemsDetails || 'Sets a starting number of items sold to make the group buy look more popular');

  const cardTitle = isEditing 
    ? (translations?.notes?.editTitle || "Manage Your Campaign") 
    : (translations?.title || "Set Up Your Campaign");
  
  const createListItems = [
    translations?.sections?.product?.description || "Select the product and variants for this campaign.",
    translations?.sections?.tiers?.description || "Define the volume discounts. Tiers must be in ascending order.",
    translations?.sections?.schedule?.description || "Set when your group buy starts and ends.",
    translations?.notes?.createLockWarning || "Note: The product and campaign type will be locked after creation."
  ];

  const editListItems = [
    translations?.notes?.editDate || "You can adjust the campaign's end date at any time.",
    translations?.notes?.editLockWarning || "Tiers and features are locked once the campaign starts or participants join.",
    translations?.notes?.editProductWarning || "The selected product and campaign type cannot be changed."
  ];

  return (
    <Form method="post" id="campaign-form" ref={formRef} replace>
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              {cardTitle}
            </Text>
            <List>
              {(isEditing ? editListItems : createListItems).map((item, index) => (
                <List.Item key={index}>{item}</List.Item>
              ))}
            </List>
          </BlockStack>
        </Card>
      <Grid>
        <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations?.sections?.product?.title || "Product & Scope"}</Text>
                {productFetcher.state === 'loading' && (
                  <BlockStack inlineAlign="center">
                    <Spinner size="small" />
                  </BlockStack>
                )}
                {selectedProducts.length > 0 && productFetcher.state !== 'loading' && (
                  <ResourceList
                    resourceName={{ singular: 'variant', plural: 'variants' }}
                    items={selectedProducts}
                    renderItem={(item) => {
                      const { variantId, title, variantTitle, image } = item;
                      const media = (
                        <Thumbnail
                          source={image || ImageIcon}
                          alt={title}
                          size="small"
                        />
                      );
                      const shortcutActions = !!initialData.id ? [] : [
                        {
                          content: <Icon source={DeleteIcon} tone="critical" />,
                          variant: 'plain',
                          accessibilityLabel: `Remove ${variantTitle}`,
                          onAction: () => handleRemoveVariant(variantId),
                        },
                      ];
                      return (
                        <ResourceItem
                          id={variantId}
                          media={media}
                          accessibilityLabel={`View details for ${title}`}
                          shortcutActions={shortcutActions}
                          persistActions
                        >
                          <Text variant="bodyMd" fontWeight="semibold" as="h3">
                            {title}
                          </Text>
                          <div>{variantTitle}</div>
                        </ResourceItem>
                      );
                    }}
                  />
                )}
                {selectedProducts.length > 0 && (
                  <Button variant="plain" tone="critical" onClick={() => onValueChange(setSelectedProducts)([])} disabled={!!initialData.id}>
                    {translations?.notes?.removeAll || "Remove all"}
                  </Button>
                )}
                {!selectedProducts.length && productFetcher.state !== 'loading' && (
                  <BlockStack gap="200">
                    <Button onClick={handleProductSelection} disabled={!!initialData.id}>
                      {translations?.sections?.product?.selectBtn || "Browse Products"}
                    </Button>
                    <Text as="p" tone="subdued">
                      {translations?.notes?.singleProductWarning || "You can only select variants from a single product for each campaign."}
                    </Text>
                  </BlockStack>
                )}
                {pickerError && <InlineError message={pickerError} fieldID="productError" />}
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingMd">{translations?.sections?.product?.scopeLabel || "Campaign Scope"}</Text>
                <BlockStack gap="200">
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={scope === 'PRODUCT'}
                      onClick={() => onValueChange(setScope)('PRODUCT')}
                      disabled={!!initialData.id && scope !== 'PRODUCT'} 
                    >
                      {/* ✨ Added Tooltip with dotted underline for Product Scope */}
                      <Tooltip content={translations?.sections?.product?.scopeProductTooltip || "The discount target applies to total sales across all variants combined."}>
                        <span style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' }}>
                          {translations?.sections?.product?.scopeProduct || "Product-wide"}
                        </span>
                      </Tooltip>
                    </Button>
                    <Button
                      pressed={scope === 'VARIANT'}
                      onClick={() => onValueChange(setScope)('VARIANT')}
                      disabled={!!initialData.id && scope !== 'VARIANT'}
                    >
                      {/* ✨ Added Tooltip with dotted underline for Variant Scope */}
                      <Tooltip content={translations?.sections?.product?.scopeVariantTooltip || "Each variant must reach the target individually to unlock the discount."}>
                        <span style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' }}>
                          {translations?.sections?.product?.scopeVariant || "Per-Variant"}
                        </span>
                      </Tooltip>
                    </Button>
                  </ButtonGroup>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{translations?.sections?.tiers?.countingMethod || "Counting Method"}</Text>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={countingMethod === 'PARTICIPANT'}
                      onClick={() => onValueChange(setCountingMethod)('PARTICIPANT')}
                      disabled={!!initialData.id && countingMethod !== 'PARTICIPANT'}
                    >
                      {/* ✨ Added Tooltip with dotted underline for Buyers count */}
                      <Tooltip content={translations?.sections?.tiers?.countBuyersTooltip || "Progress increases by 1 for each unique order, regardless of how many items they buy."}>
                        <span style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' }}>
                          {translations?.sections?.tiers?.countBuyers || "By Participants"}
                        </span>
                      </Tooltip>
                    </Button>
                    <Button
                      pressed={countingMethod === 'ITEM_QUANTITY'}
                      onClick={() => onValueChange(setCountingMethod)('ITEM_QUANTITY')}
                      disabled={!!initialData.id && countingMethod !== 'ITEM_QUANTITY'}
                    >
                      {/* ✨ Added Tooltip with dotted underline for Items count */}
                      <Tooltip content={translations?.sections?.tiers?.countItemsTooltip || "Progress increases based on the actual quantity of items purchased."}>
                        <span style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' }}>
                          {translations?.sections?.tiers?.countItems || "By Item Quantity"}
                        </span>
                      </Tooltip>
                    </Button>
                  </ButtonGroup>
                </BlockStack>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations?.sections?.tiers?.title || "Discount Tiers"}</Text>
                <FormLayout>
                  {tiers.map((tier, index) => {
                    const tierPrefix = translations?.sections?.tiers?.tierPrefix || "Tier";
                    return (
                      <FormLayout.Group key={index}>
                        <TextField 
                          label={`${tierPrefix} ${index + 1}: ${tierLabel}`}
                          value={tier.quantity}
                          onChange={(v) => handleTierChange(index, 'quantity', v)}
                          disabled={isStarted || hasParticipants} 
                          error={tierErrors[index]?.quantity} 
                          autoComplete="off" 
                        />
                        <TextField 
                          label={translations?.sections?.tiers?.tierDiscount || "Discount (%)"} 
                          value={tier.discount} 
                          onChange={(v) => handleTierChange(index, 'discount', v)} 
                          disabled={isStarted || hasParticipants} 
                          error={tierErrors[index]?.discount} 
                          autoComplete="off" 
                        />
                        <div style={{ marginTop: '10px' }}>
                          <Button 
                            icon={DeleteIcon} 
                            onClick={() => handleRemoveTier(index)} 
                            disabled={tiers.length === 1 || hasParticipants} 
                            accessibilityLabel={`Remove Tier ${index + 1}`} 
                          />
                        </div>
                      </FormLayout.Group>
                    );
                  })}
                </FormLayout>
                <Button onClick={handleAddTier} icon={PlusIcon} disabled={isStarted || hasParticipants}>{translations?.sections?.tiers?.addTier || "Add Tier"}</Button>
              </BlockStack>
            </Card>
          </BlockStack>
        </Grid.Cell>
        <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 6, xl: 6 }}>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations?.sections?.schedule?.title || "Scheduling"}</Text>
                <Autocomplete options={filteredTimezoneOptions} selected={[timezone]} onSelect={handleSelectTimezone} disabled={isStarted}
                  textField={<Autocomplete.TextField onChange={handleTimezoneInputChange} label={translations?.sections?.schedule?.timezone || "Timezone"} value={timezoneInputValue} placeholder="Search for a timezone" autoComplete="off" disabled={isStarted} />}
                />
                <Text as="p" tone="subdued" alignment="center">
                  {translations?.notes?.currentTime || "Current time in"} {timezone.replace(/_/g, ' ')} {translations?.notes?.is || "is"}{' '}
                  <strong>{formatInTimeZone(liveTime, timezone, 'MMM d, yyyy, HH:mm:ss')}</strong>.
                </Text>
                <DateTimePicker
                  label={translations?.sections?.schedule?.startDate || "Start Date"}
                  timezone={timezone}
                  selectedDateTime={startDate}
                  onDateTimeChange={onValueChange(setStartDate)}
                  minDateTime={minStartDateTime}
                  inclusive={true}
                  disabled={isStarted}
                  error={formErrors?.schedule?.startDate}
                />
                <DateTimePicker
                  label={translations?.sections?.schedule?.endDate || "End Date"}
                  timezone={timezone}
                  selectedDateTime={endDate}
                  onDateTimeChange={onValueChange(setEndDate)}
                  minDateTime={minEndDateTime}
                  inclusive={isEndDateInclusive}
                  disabled={isFinished}
                  error={formErrors?.schedule?.endDate}
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations?.sections?.features?.title || "Features"}</Text>
                <Text as="p" tone="subdued">
                  {translations?.sections?.features?.note || "Note: Leader Discount and Fake Count cannot be used simultaneously. Enabling one will automatically turn off the other."}
                </Text>
                <s-switch
                  ref={leaderDiscountSwitchRef}
                  label={translations?.sections?.features?.leaderLabel || "Leader discount (%)"}
                  details={translations?.sections?.features?.leaderDetails || "First participants will receive a discount when they join a group buy"}
                  onInput={handleLeaderDiscountToggle}
                  disabled={isStarted || hasParticipants}
                ></s-switch>
                <TextField
                  value={leaderDiscount}
                  onChange={handleLeaderDiscountChange}
                  disabled={!leaderDiscountEnabled || isStarted || hasParticipants}
                  error={formErrors?.leaderDiscount}
                  autoComplete="off"
                />
                <s-switch
                  ref={startingParticipantsSwitchRef}
                  label={startingCountLabel}
                  details={startingCountDetails}
                  onInput={handleStartingParticipantsToggle}
                  disabled={isStarted || hasParticipants}
                ></s-switch>
                <TextField
                  value={startingParticipants}
                  onChange={handleNumericChange(setStartingParticipants)}
                  disabled={!startingParticipantsEnabled || isStarted || hasParticipants}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Grid.Cell>
      </Grid>
      </BlockStack>            
      {selectedProducts.length > 0 && (
        <>
          <input type="hidden" name="productId" value={selectedProducts[0].id} />
          <input type="hidden" name="productTitle" value={selectedProducts[0].title} />
          <input type="hidden" name="productImage" value={selectedProducts[0].image} />
          <input type="hidden" name="productHandle" value={selectedProducts[0].handle || ""} />
          <input
            type="hidden"
            name="selectedVariantIdsJson"
            value={JSON.stringify(selectedProducts.map(p => p.variantId))}
          />
        </>
      )}
      <input type="hidden" name="startDate" value={startDate || ''} />
      <input type="hidden" name="endDate" value={endDate || ''} />
      <input type="hidden" name="timezone" value={timezone} />
      <input type="hidden" name="tiers" value={JSON.stringify(tiers)} />
      <input 
        type="hidden" 
        name="startingParticipants" 
        value={startingParticipantsEnabled ? startingParticipants : '0'} 
      />
      <input 
        type="hidden" 
        name="leaderDiscount" 
        value={leaderDiscountEnabled ? (leaderDiscount || '0') : '0'} 
      />
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="countingMethod" value={countingMethod} />
    </Form>
  );
});