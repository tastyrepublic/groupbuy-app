import { useState, useEffect, useMemo } from 'react';
import { Popover, TextField, Icon, InlineGrid } from '@shopify/polaris';
import { CalendarIcon, ClockIcon, ChevronLeftIcon, ChevronRightIcon } from '@shopify/polaris-icons';
import { formatInTimeZone, toDate } from 'date-fns-tz';
import { format, getDaysInMonth, addMonths, subMonths } from 'date-fns';

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
  const [datePopoverActive, setDatePopoverActive] = useState(false);
  const [timePopoverActive, setTimePopoverActive] = useState(false);
  const [timeMode, setTimeMode] = useState('hour');

  // --- 🔒 UNTOUCHED LOGIC: Timezone Handling ---
  const selectedDateObj = selectedDateTime ? toDate(selectedDateTime) : toDate(new Date(), { timeZone: timezone });
  const [viewDate, setViewDate] = useState(selectedDateObj);

  useEffect(() => {
    if (selectedDateTime) setViewDate(toDate(selectedDateTime, { timeZone: timezone }));
  }, [selectedDateTime, timezone]);

  const minDateStr = useMemo(() => {
    if (!minDateTime) return null;
    return formatInTimeZone(toDate(minDateTime), timezone, 'yyyy-MM-dd');
  }, [minDateTime, timezone]);

  // --- 🎨 HK-DRIVE STYLE: Date Selection ---
  const handleDateClick = (day) => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const existingTime = selectedDateTime ? formatInTimeZone(toDate(selectedDateTime), timezone, 'HH:mm:ss') : '09:00:00';
    const newDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let newDateTime = toDate(`${newDateStr}T${existingTime}`, { timeZone: timezone });

    // Enforce minDateTime bounds during date switch
    if (minDateTime && newDateTime < minDateTime) {
      newDateTime = toDate(minDateTime);
    }
    
    onDateTimeChange(newDateTime.toISOString());
    setDatePopoverActive(false);
  };

  // --- 🎨 HK-DRIVE STYLE: Time Logic ---
  const [curH, curM] = selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'HH:mm').split(':') : ['09', '00'];

  const handleTimeClick = (type, val) => {
    const datePart = formatInTimeZone(selectedDateObj, timezone, 'yyyy-MM-dd');
    const h = type === 'hour' ? val : curH;
    const m = type === 'minute' ? val : curM;
    const newDateTime = toDate(`${datePart}T${h}:${m}:00`, { timeZone: timezone });
    
    onDateTimeChange(newDateTime.toISOString());
    if (type === 'hour') {
      setTimeMode('minute');
    } else {
      setTimePopoverActive(false);
      setTimeMode('hour');
    }
  };

  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const minutes = ['00', '10', '20', '30', '40', '50'];

  // --- 🔒 UNTOUCHED LOGIC: Disabling past times ---
  const isTimeDead = (type, val) => {
    if (!minDateTime) return false;
    
    const selDayStr = formatInTimeZone(selectedDateObj, timezone, 'yyyy-MM-dd');
    const minD = toDate(minDateTime);
    const minDayStr = formatInTimeZone(minD, timezone, 'yyyy-MM-dd');
    
    if (selDayStr < minDayStr) return true;
    if (selDayStr > minDayStr) return false;

    // We are on the exact same day as the minimum date. Apply hour/minute restrictions.
    const [minH, minM] = formatInTimeZone(minD, timezone, 'HH:mm').split(':').map(Number);
    
    if (type === 'hour') return Number(val) < minH;
    
    if (type === 'minute') {
      if (Number(curH) < minH) return true;
      if (Number(curH) > minH) return false;
      // Exact same hour, check minutes using the 'inclusive' rule
      return inclusive ? Number(val) < minM : Number(val) <= minM;
    }
    return false;
  };

  const formattedDate = selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'MMM d, yyyy') : '';
  const formattedTime = selectedDateTime ? formatInTimeZone(selectedDateObj, timezone, 'HH:mm') : 'Select time';

  return (
    <InlineGrid columns="1fr auto" gap="200" alignItems="end">
      
      {/* Date Picker Popover */}
      <Popover
        active={datePopoverActive}
        onClose={() => setDatePopoverActive(false)}
        activator={
          <TextField 
            label={label} 
            value={formattedDate} 
            prefix={<Icon source={CalendarIcon} />} 
            onFocus={() => setDatePopoverActive(true)} 
            autoComplete="off" 
            disabled={disabled} 
            error={error} 
          />
        }
      >
        <div style={{ padding: '16px', width: '280px', backgroundColor: '#fff', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button onClick={() => setViewDate(subMonths(viewDate, 1))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}>
              <Icon source={ChevronLeftIcon} />
            </button>
            <span style={{ fontWeight: 'bold', fontSize: '14px', color: '#202223' }}>{format(viewDate, 'MMMM yyyy')}</span>
            <button onClick={() => setViewDate(addMonths(viewDate, 1))} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}>
              <Icon source={ChevronRightIcon} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '8px' }}>
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 'bold', color: '#6d7175' }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
            {Array.from({ length: getDaysInMonth(viewDate) }, (_, i) => {
              const day = i + 1;
              const dateStr = format(new Date(viewDate.getFullYear(), viewDate.getMonth(), day), 'yyyy-MM-dd');
              const isPast = minDateStr ? dateStr < minDateStr : false;
              const isSelected = formattedDate === format(new Date(viewDate.getFullYear(), viewDate.getMonth(), day), 'MMM d, yyyy');
              
              return (
                <button 
                  key={day} 
                  disabled={isPast} 
                  onClick={() => handleDateClick(day)} 
                  style={{
                    aspectRatio: '1/1', border: 'none', borderRadius: '4px', cursor: isPast ? 'not-allowed' : 'pointer', fontWeight: 'bold', fontSize: '12px',
                    backgroundColor: isSelected ? '#8a2be2' : 'transparent', 
                    color: isSelected ? '#fff' : isPast ? '#d2d5d8' : '#202223',
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      </Popover>

      {/* Time Picker Popover */}
      <Popover
        active={timePopoverActive}
        onClose={() => { setTimePopoverActive(false); setTimeMode('hour'); }}
        activator={
          <div style={{ width: '120px' }}>
            <TextField 
              label="Time" 
              labelHidden 
              value={formattedTime} 
              prefix={<Icon source={ClockIcon} />} 
              onFocus={() => setTimePopoverActive(true)} 
              autoComplete="off" 
              disabled={disabled} 
            />
          </div>
        }
      >
        <div style={{ padding: '16px', width: '280px', backgroundColor: '#fff', borderRadius: '8px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
             <button 
               onClick={() => setTimeMode('hour')} 
               style={{ flex: 1, padding: '8px', borderRadius: '8px', border: timeMode === 'hour' ? '2px solid #8a2be2' : '1px solid #e1e3e5', backgroundColor: timeMode === 'hour' ? '#f3e8ff' : '#fff', color: timeMode === 'hour' ? '#8a2be2' : '#202223', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' }}
             >
               {curH}
             </button>
             <span style={{ fontSize: '20px', fontWeight: 'bold', alignSelf: 'center' }}>:</span>
             <button 
               onClick={() => setTimeMode('minute')} 
               style={{ flex: 1, padding: '8px', borderRadius: '8px', border: timeMode === 'minute' ? '2px solid #8a2be2' : '1px solid #e1e3e5', backgroundColor: timeMode === 'minute' ? '#f3e8ff' : '#fff', color: timeMode === 'minute' ? '#8a2be2' : '#202223', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' }}
             >
               {curM}
             </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: timeMode === 'hour' ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: '8px' }}>
             {(timeMode === 'hour' ? hours : minutes).map(val => {
               const dead = isTimeDead(timeMode, val);
               const isSelected = (timeMode === 'hour' ? curH : curM) === val;
               return (
                 <button 
                   key={val} 
                   disabled={dead} 
                   onClick={() => handleTimeClick(timeMode, val)} 
                   style={{
                     padding: '10px', borderRadius: '6px', border: isSelected ? '1px solid #8a2be2' : '1px solid #e1e3e5', fontWeight: 'bold', fontSize: '14px',
                     backgroundColor: isSelected ? '#8a2be2' : '#fff', color: isSelected ? '#fff' : '#202223',
                     opacity: dead ? 0.3 : 1, cursor: dead ? 'not-allowed' : 'pointer'
                   }}
                 >
                   {val}
                 </button>
               );
             })}
          </div>
        </div>
      </Popover>

    </InlineGrid>
  );
}