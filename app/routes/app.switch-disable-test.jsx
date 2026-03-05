import { useState, useRef, useEffect } from "react";
import { Page, Card, Text, BlockStack, Grid, Banner } from "@shopify/polaris";

// Reusable component for a single switch test case
function SwitchTestCase({
  title,
  explanation,
  initialChecked,
  useDynamicLabel,
  useFix, // <-- The flag to use the setTimeout fix
}) {
  const switchRef = useRef(null);
  const [dynamicLabel] = useState("Dynamic Label Text");
  const label = useDynamicLabel ? dynamicLabel : "Static Label Text";

  useEffect(() => {
    const switchEl = switchRef.current;
    if (!switchEl) return;

    // All switches in this test are disabled from the start.
    switchEl.disabled = true;

    if (useFix) {
      // --- THE ROBUST FIX ---
      // Defer setting the 'checked' state to the next browser tick.
      setTimeout(() => {
        if (switchRef.current) {
          switchRef.current.checked = initialChecked;
        }
      }, 0);
    } else {
      // --- THE BUGGY LOGIC ---
      // Set 'checked' synchronously, causing the race condition.
      switchEl.checked = initialChecked;
    }
  }, []); // Run only on mount

  return (
    <Card>
      <BlockStack gap="400">
        <Text variant="headingMd" as="h3">{title}</Text>
        <Text as="p">{explanation}</Text>
        <s-switch ref={switchRef} label={label}></s-switch>
      </BlockStack>
    </Card>
  );
}

// --- MAIN PAGE TO RENDER ALL TESTS ---
export default function FinalComprehensiveTest() {
  return (
    <Page title="Comprehensive Switch Race Condition Test">
      <Grid>
        {/* --- COLUMN 1: THE BUGGY IMPLEMENTATION --- */}
        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
          <BlockStack gap="500">
            <Text variant="headingLg" as="h2">Buggy Version ❌</Text>
            <Text>No fix applied. Notice how only the "unchecked" switch is correctly disabled.</Text>
            
            <SwitchTestCase
              title="Checked + Static Label"
              explanation="This FAILS. It should be disabled but isn't."
              initialChecked={true}
              useDynamicLabel={false}
              useFix={false}
            />
            <SwitchTestCase
              title="Checked + Dynamic Label"
              explanation="This also FAILS. It should be disabled but isn't."
              initialChecked={true}
              useDynamicLabel={true}
              useFix={false}
            />
            <SwitchTestCase
              title="Unchecked + Static Label"
              explanation="This WORKS. The bug isn't triggered when checked=false."
              initialChecked={false}
              useDynamicLabel={false}
              useFix={false}
            />
             <Banner title="Try Reloading!" tone="warning">
              <p>When two switches fail together, they may invert their disabled status on reload. This proves they are interfering.</p>
            </Banner>
          </BlockStack>
        </Grid.Cell>

        {/* --- COLUMN 2: THE ROBUST FIX --- */}
        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
          <BlockStack gap="500">
            <Text variant="headingLg" as="h2">Fixed Version ✅</Text>
            <Text>The `setTimeout` fix is applied to all switches. All are correctly disabled.</Text>

            <SwitchTestCase
              title="Checked + Static Label"
              explanation="This WORKS. It is correctly disabled on load."
              initialChecked={true}
              useDynamicLabel={false}
              useFix={true}
            />
            <SwitchTestCase
              title="Checked + Dynamic Label"
              explanation="This also WORKS. It is correctly disabled on load."
              initialChecked={true}
              useDynamicLabel={true}
              useFix={true}
            />
            <SwitchTestCase
              title="Unchecked + Static Label"
              explanation="This continues to WORK as expected."
              initialChecked={false}
              useDynamicLabel={false}
              useFix={true}
            />
          </BlockStack>
        </Grid.Cell>
        
        {/* --- COLUMN 3: LIVE UPDATE TEST --- */}
        <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
           <LiveUpdateTest />
        </Grid.Cell>
      </Grid>
    </Page>
  );
}


// A self-contained component for the live update test
function LiveUpdateTest() {
  const [startTime] = useState(() => new Date(Date.now() + 5000));
  const [liveTime, setLiveTime] = useState(new Date());
  const isStarted = liveTime >= startTime;
  const switchRef = useRef(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    const timer = setInterval(() => setLiveTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const switchEl = switchRef.current;
    if (!switchEl) return;
    if (isInitialMount.current) {
      switchEl.disabled = false;
      switchEl.checked = true;
      isInitialMount.current = false;
    } else {
      switchEl.disabled = isStarted;
    }
  }, [isStarted]);

  const countdown = Math.max(0, Math.round((startTime - liveTime) / 1000));

  return (
    <BlockStack gap="500">
       <Text variant="headingLg" as="h2">Live Update ⏳</Text>
       <Text>Proves the form can be locked in real-time without bugs.</Text>
       <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h3">Pending Campaign</Text>
            {countdown > 0 ? <Text>Starts in: <strong>{countdown}s</strong></Text> : <Text>Campaign is now active!</Text>}
             <Banner tone={isStarted ? "success" : "warning"} title={`Active: ${isStarted.toString()}`} />
             <s-switch ref={switchRef} label="Starts Enabled, Becomes Locked"></s-switch>
          </BlockStack>
       </Card>
    </BlockStack>
  );
}