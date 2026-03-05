import { json } from "@remix-run/node";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Page, Card, Text, Autocomplete, Popover, DatePicker, TextField, Icon, Select, BlockStack, InlineGrid, Spinner } from '@shopify/polaris';
import { CalendarIcon } from '@shopify/polaris-icons';
import { formatInTimeZone, toDate } from 'date-fns-tz';
import { format, set, addMinutes } from 'date-fns';

export const loader = async () => {
  return json({});
};

function DateTimePicker({
  label,
  timezone,
  selectedDateTime,
  onDateTimeChange,
  minDateTime,
  inclusive,
}) {
  const [popoverActive, setPopoverActive] = useState(false);
  const selectedDateObj = selectedDateTime ? toDate(selectedDateTime, { timeZone: timezone }) : new Date();
  const [{ month, year }, setDate] = useState({ month: selectedDateObj.getMonth(), year: selectedDateObj.getFullYear() });

  useEffect(() => {
    if (selectedDateTime) {
      const newDate = toDate(selectedDateTime, { timeZone: timezone });
      setDate({ month: newDate.getMonth(), year: newDate.getFullYear() });
    }
  }, [selectedDateTime, timezone]);

  const dateForPicker = useMemo(() => {
    if (!selectedDateTime) return new Date();
    const y = Number(formatInTimeZone(selectedDateObj, timezone, 'yyyy'));
    const m = Number(formatInTimeZone(selectedDateObj, timezone, 'M')) - 1;
    const d = Number(formatInTimeZone(selectedDateObj, timezone, 'd'));
    return new Date(Date.UTC(y, m, d));
  }, [selectedDateObj, timezone]);

  // ✅ DEFINITIVE FIX: The rollover logic is removed from the component.
  // It now uses the most reliable universal method.
  const disableBeforeDate = useMemo(() => {
    if (!minDateTime) return null;
    const minDate = toDate(minDateTime);
    const y = Number(formatInTimeZone(minDate, timezone, 'yyyy'));
    const m = Number(formatInTimeZone(minDate, timezone, 'M')) - 1;
    const d = Number(formatInTimeZone(minDate, timezone, 'd'));
    return new Date(y, m, d);
  }, [minDateTime, timezone]);

  const handleDateChange = useCallback(({ start }) => {
    const existingTime = formatInTimeZone(toDate(selectedDateTime, { timeZone: timezone }), timezone, 'HH:mm:ss');
    const newDateStr = format(start, 'yyyy-MM-dd');
    const newDateTimeStr = `${newDateStr}T${existingTime}`;
    const newDateTime = toDate(newDateTimeStr, { timeZone: timezone });
    if (newDateTime < minDateTime) {
      onDateTimeChange(minDateTime.toISOString());
    } else {
      onDateTimeChange(newDateTime.toISOString());
    }
    setPopoverActive(false);
  }, [selectedDateTime, timezone, minDateTime, onDateTimeChange]);

  const handleTimeChange = useCallback((selectedTime) => {
    const datePart = formatInTimeZone(selectedDateObj, timezone, 'yyyy-MM-dd');
    const newDateTimeStr = `${datePart}T${selectedTime}:00`;
    const newDateTime = toDate(newDateTimeStr, { timeZone: timezone });
    onDateTimeChange(newDateTime.toISOString());
  }, [selectedDateObj, timezone, onDateTimeChange]);

  const timeOptions = useMemo(() => {
    const allOptions = Array.from({ length: 48 }, (_, i) => { const h = Math.floor(i / 2); const m = (i % 2) * 30; return { label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, value: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }; });
    if (!minDateTime) return allOptions;
    const selectedDayStr = formatInTimeZone(selectedDateObj, timezone, 'yyyy-MM-dd');
    const minDayStr = formatInTimeZone(minDateTime, timezone, 'yyyy-MM-dd');
    if (selectedDayStr > minDayStr) return allOptions;
    const [minHour, minMinute] = formatInTimeZone(minDateTime, timezone, 'HH:mm').split(':').map(Number);
    return allOptions.filter(o => { const [h, m] = o.value.split(':').map(Number); if (h > minHour) return true; if (inclusive) { if (h === minHour && m >= minMinute) return true; } else { if (h === minHour && m > minMinute) return true; } return false; });
  }, [selectedDateObj, timezone, minDateTime, inclusive]);

  const formattedDateForField = useMemo(() => selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'MMMM d, yyyy') : '', [selectedDateTime, timezone, selectedDateObj]);
  const formattedTimeForSelect = useMemo(() => selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'HH:mm') : '', [selectedDateTime, timezone, selectedDateObj]);
  const datePickerActivator = (<TextField label={label} value={formattedDateForField} prefix={<Icon source={CalendarIcon} />} autoComplete="off" onFocus={() => setPopoverActive(true)} />);

  return (
    <InlineGrid columns="1fr auto" gap="200" alignItems="end">
      <Popover active={popoverActive} activator={datePickerActivator} onClose={() => setPopoverActive(false)}>
        <Card>
          <DatePicker month={month} year={year} onChange={handleDateChange} onMonthChange={(m, y) => setDate({ month: m, year: y })} selected={dateForPicker} disableDatesBefore={disableBeforeDate} />
        </Card>
      </Popover>
      <Select label="Time" labelHidden options={timeOptions} value={formattedTimeForSelect} onChange={handleTimeChange} />
    </InlineGrid>
  );
}


export default function TestPage() {
  const [timezone, setTimezone] = useState(null);
  const [timezoneInputValue, setTimezoneInputValue] = useState('');
  const [liveTime, setLiveTime] = useState(new Date());

  const [startDateTime, setStartDateTime] = useState('');
  const [minStartDateTime, setMinStartDateTime] = useState(new Date());
  const [endDateTime, setEndDateTime] = useState('');

  useEffect(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(browserTimezone);
    setTimezoneInputValue(browserTimezone.replace(/_/g, ' '));
    const timer = setInterval(() => setLiveTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!timezone) return;
    const now = new Date();
    const startTime = new Date(now.getTime());
    if (startTime.getMinutes() < 30) {
      startTime.setMinutes(30, 0, 0);
    } else {
      startTime.setHours(startTime.getHours() + 1);
      startTime.setMinutes(0, 0, 0);
    }
    setMinStartDateTime(startTime);
    setStartDateTime(startTime.toISOString());
  }, [timezone]);

  useEffect(() => {
    if (!startDateTime) return;
    const startDate = toDate(startDateTime);
    const endDate = endDateTime ? toDate(endDateTime) : new Date(0);
    if (endDate <= startDate) {
      const newEndDate = addMinutes(startDate, 30);
      setEndDateTime(newEndDate.toISOString());
    }
  }, [startDateTime]);

  // ✅ DEFINITIVE FIX: The 23:30 rollover logic is now handled here, only for the end date.
  const minEndDateTime = useMemo(() => {
    if (!startDateTime) return null;
    let minDate = toDate(startDateTime);
    const [startHour, startMinute] = formatInTimeZone(minDate, timezone, 'HH:mm').split(':').map(Number);
    if (startHour === 23 && startMinute === 30) {
      minDate = addMinutes(minDate, 30);
    }
    return minDate;
  }, [startDateTime, timezone]);

  const isEndDateInclusive = useMemo(() => {
    if (!startDateTime || !endDateTime) return true;
    const startDateStr = formatInTimeZone(toDate(startDateTime), timezone, 'yyyy-MM-dd');
    const endDateStr = formatInTimeZone(toDate(endDateTime), timezone, 'yyyy-MM-dd');
    return startDateStr !== endDateStr;
  }, [startDateTime, endDateTime, timezone]);

  const formattedLiveTime = useMemo(() => { if (!timezone) return '...'; return formatInTimeZone(liveTime, timezone, 'MMM d, yyyy, HH:mm:ss'); }, [liveTime, timezone]);
  const allTimezoneOptions = useMemo(() => Intl.supportedValuesOf('timeZone').map((tz) => ({ value: tz, label: tz.replace(/_/g, ' ') })), []);
  const [filteredTimezoneOptions, setFilteredTimezoneOptions] = useState([]);
  useEffect(() => { setFilteredTimezoneOptions(allTimezoneOptions) }, [allTimezoneOptions]);
  const handleTimezoneInputChange = (value) => { setTimezoneInputValue(value); setFilteredTimezoneOptions(value === '' ? allTimezoneOptions : allTimezoneOptions.filter((o) => o.label.match(new RegExp(value, 'i')))); };
  const handleSelectTimezone = (selected) => { const tz = selected[0]; setTimezone(tz); setTimezoneInputValue(allTimezoneOptions.find(o => o.value === tz)?.label || tz); };

  if (!timezone || !startDateTime) {
    return (<Page><Card sectioned><Spinner accessibilityLabel="Detecting timezone" size="large" /></Card></Page>);
  }

  return (
    <Page title="Date Logic Test - Final">
      <Card>
        <BlockStack gap="500">
          <BlockStack gap="200">
            <Autocomplete
              options={filteredTimezoneOptions} selected={[timezone]} onSelect={handleSelectTimezone}
              textField={<Autocomplete.TextField onChange={handleTimezoneInputChange} label="Timezone" value={timezoneInputValue} />}
            />
            <Text as="p" tone="subdued">Current time: <strong>{formattedLiveTime}</strong></Text>
          </BlockStack>
          <BlockStack gap="400">
            <DateTimePicker
              label="Start Date"
              timezone={timezone}
              selectedDateTime={startDateTime}
              onDateTimeChange={setStartDateTime}
              minDateTime={minStartDateTime}
              inclusive={true}
            />
            <DateTimePicker
              label="End Date"
              timezone={timezone}
              selectedDateTime={endDateTime}
              onDateTimeChange={setEndDateTime}
              minDateTime={minEndDateTime}
              inclusive={isEndDateInclusive}
            />
          </BlockStack>
          <div style={{ padding: '1rem', border: '1px solid green' }}>
            <p><strong>DEBUG OUTPUT:</strong></p>
            <p>Start Value (UTC): <strong>{startDateTime || '...'}</strong></p>
            <p>End Value (UTC): <strong>{endDateTime || '...'}</strong></p>
          </div>
        </BlockStack>
      </Card>
    </Page>
  );
}