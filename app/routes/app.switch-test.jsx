import { useState, useCallback, useRef, useEffect } from "react";
import { Page, Card, Text, BlockStack } from "@shopify/polaris";

export default function SwitchTestPage() {
  const [isChecked, setIsChecked] = useState(false);
  const [textValue, setTextValue] = useState('');

  const switchRef = useRef(null); // Ref for the imperative method

  const handleSwitchInput = useCallback((event) => {
    setIsChecked(event.currentTarget.checked);
  }, []);

  const handleTextInput = useCallback((event) => {
    setTextValue(event.currentTarget.value);
  }, []);
  
  // This effect forces the web component to sync with React state
  useEffect(() => {
    if (switchRef.current) {
      switchRef.current.checked = isChecked;
    }
  }, [isChecked]);

  return (
    <Page>
      <Card>
        <BlockStack gap="500">
          <Text as="h1" variant="headingLg">Web Component Sync Test</Text>
          
          {/* --- A text field to trigger extra re-renders --- */}
          <s-text-field
            label="Type here to trigger re-renders"
            value={textValue}
            onInput={handleTextInput}
          ></s-text-field>

          {/* --- TEST 1: The 'checked' attribute method --- */}
          <BlockStack gap="200" style={{border: '1px solid red', padding: '10px'}}>
            <Text variant="headingMd">Method 1: `checked` Attribute (Can Fail)</Text>
            <s-switch
              label="Click me first"
              checked={isChecked ? "" : undefined}
              onInput={handleSwitchInput}
            ></s-switch>
            <Text as="p">
              This switch might not update visually on the first click if you type in the text box above, because extra re-renders can cause a conflict.
            </Text>
          </BlockStack>

          {/* --- TEST 2: The 'ref' and 'useEffect' method --- */}
          <BlockStack gap="200" style={{border: '1px solid green', padding: '10px'}}>
            <Text variant="headingMd">Method 2: `ref` and `useEffect` (Reliable)</Text>
            <s-switch
              ref={switchRef}
              label="Click me second"
              onInput={handleSwitchInput}
            ></s-switch>
            <Text as="p">
              This switch will always update correctly because the `useEffect` hook forces its visual state to match the React state after every render.
            </Text>
          </BlockStack>

          {/* --- The source of truth --- */}
          <div style={{ marginTop: '20px', padding: '10px', background: '#f9fafb' }}>
            <Text as="p">
              <strong>React State (`isChecked`) is:</strong> {isChecked ? 'ON' : 'OFF'}
            </Text>
          </div>

        </BlockStack>
      </Card>
    </Page>
  );
}