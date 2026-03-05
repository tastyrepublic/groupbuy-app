import { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, Popover, DatePicker, TextField, Icon, Select, InlineGrid } from '@shopify/polaris';
import { CalendarIcon } from '@shopify/polaris-icons';
import { formatInTimeZone, toDate } from 'date-fns-tz';
import { format } from 'date-fns';

export function DateTimePicker({
  label,
  timezone,
  selectedDateTime,
  onDateTimeChange,
  minDateTime,
  inclusive,
  disabled,
  error,
}) {
  const [popoverActive, setPopoverActive] = useState(false);

  const selectedDateObj = selectedDateTime ? toDate(selectedDateTime) : toDate(new Date(), { timeZone: timezone });
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
    return new Date(Date.UTC(y, m, d)); // Use UTC to prevent timezone shifts
  }, [selectedDateObj, timezone]);

  const disableBeforeDate = useMemo(() => {
    if (!minDateTime) return null;
    const minDate = toDate(minDateTime);
    const y = Number(formatInTimeZone(minDate, timezone, 'yyyy'));
    const m = Number(formatInTimeZone(minDate, timezone, 'M')) - 1;
    const d = Number(formatInTimeZone(minDate, timezone, 'd'));
    return new Date(y, m, d);
  }, [minDateTime, timezone]);

  const handleDateChange = useCallback(({ start }) => {
    const existingTime = selectedDateTime ? formatInTimeZone(toDate(selectedDateTime), timezone, 'HH:mm:ss') : '09:00:00';
    const newDateStr = format(start, 'yyyy-MM-dd');
    const newDateTimeStr = `${newDateStr}T${existingTime}`;
    let newDateTime = toDate(newDateTimeStr, { timeZone: timezone });

    if (minDateTime && newDateTime < minDateTime) {
      newDateTime = toDate(minDateTime);
    }
    
    onDateTimeChange(newDateTime.toISOString());
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
    if (selectedDayStr < minDayStr) return [];

    const [minHour, minMinute] = formatInTimeZone(minDateTime, timezone, 'HH:mm').split(':').map(Number);
    
    return allOptions.filter(o => { 
        const [h, m] = o.value.split(':').map(Number); 
        if (h > minHour) return true; 

        if (inclusive) {
            if (h === minHour && m >= minMinute) return true;
        } else {
            if (h === minHour && m > minMinute) return true;
        }
        
        return false; 
    });
  }, [selectedDateObj, timezone, minDateTime, inclusive]);

  const formattedDateForField = useMemo(() => selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'MMMM d, yyyy') : '', [selectedDateTime, timezone, selectedDateObj]);
  const formattedTimeForSelect = useMemo(() => selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'HH:mm') : '', [selectedDateTime, timezone, selectedDateObj]);
  const datePickerActivator = (<TextField label={label} value={formattedDateForField} prefix={<Icon source={CalendarIcon} />} autoComplete="off" onFocus={() => setPopoverActive(true)} disabled={disabled} error={error} />);

  return (
    <InlineGrid columns="1fr auto" gap="200" alignItems="end">
      <Popover active={popoverActive} activator={datePickerActivator} onClose={() => setPopoverActive(false)}>
        <Card>
          <DatePicker month={month} year={year} onChange={handleDateChange} onMonthChange={(m, y) => setDate({month: m, year: y})} selected={dateForPicker} disableDatesBefore={disableBeforeDate} />
        </Card>
      </Popover>
      <Select label="Time" labelHidden options={timeOptions} value={formattedTimeForSelect} onChange={handleTimeChange} disabled={disabled || timeOptions.length === 0} />
    </InlineGrid>
  );
}