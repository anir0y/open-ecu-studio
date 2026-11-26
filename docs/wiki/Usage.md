# Using Open ECU Studio

Start with the **Dynamics model** to drive the car and see how a change at the controls appears in a CAN frame. Use the **STM32 reference ECU** for a second experiment in which the firmware produces a repeating wheel-slip event. Both run on the software lab's virtual bus.

## Drive and read the steering angle

1. Wait for **Lab connected**. In **Drive lab**, select **Dynamics model**, choose **Start simulation**, then **Cruise**. Watch the speed readout beside the car.
2. Change **Steering command** and watch **Measured** follow it. Select **Center steering** and wait for the measured angle to return to 0.0°. You can also use W for throttle, S for brake, and A and D for steering when the focus is outside an input field.
3. Open **Packet classroom**. Choose **Right turn** under **Worked example**, then select **Road-wheel steering** in the table. Bytes B2 and B3 show `00 78`, or 120 in decimal. Dividing by ten gives +12.0°. **Left turn** uses the same bytes for a signed negative value.
4. Choose **Capture latest 0x182** to read a dynamics frame from the current run. The heading changes from the worked example name to the captured frame number. **Download worksheet CSV** saves the selected packet and its decoded fields.

## Pair a body control with a packet

With the connected dynamics model, open **Body controls**. These controls also work while the car is parked.

| Change one control | What to observe |
| --- | --- |
| Set **Headlights** to **Low beam**, then **High beam** | Compare the lamps and byte B0 in **Latest body status**. |
| Set **Indicators** to **Left**, then **Hazards** | Watch which lamps flash and inspect B1 for the selected signal mode. |
| Close both doors, choose **Unlocked** under **Central lock**, then open the **Left door** | The cabin light comes on. B2 bit 0 records the left door and B5 records the cabin light. Close the door before selecting **Locked**. |

Select **Inspect** below the `0x361` body status packet to open that observation in the packet classroom. For the two-car exercise, use **Press fob unlock** and **Pull both handles** to observe a fresh unlock on both cars. Use **Close both doors** and **Lock both cars** to return them to a locked state. **Download run worksheet (CSV)** records the exercise, including the handle outcomes.

## Freeze the first wheel slip

1. With the dynamics simulation running, choose **Cruise** and let the car gain speed.
2. In **Freeze ESC event**, choose **Arm for first slip**. Return to the driver controls and choose **Split grip**.
3. The capture triggers when the front-left wheel becomes at least 4 km/h faster than the rear-left wheel. The event panel freezes while the simulation continues. Expand **Wheel speeds before slip** to compare the preceding sample with the onset.
4. Read the three packet cards side by side. `0x181` contains the four wheel speeds, `0x182` contains brake pressure, and `0x280` reports ESC intervention. Compare each card's frame number and time offset from slip. If a report was missing, the worksheet marks it as missing.
5. Choose **Download event worksheet (CSV)** before **Return to live** or **Arm for next slip**. To capture another onset, choose **Cruise**, wait for the wheel speeds to recover, arm the capture, then choose **Split grip** again.

For a firmware-led run in the desktop or local browser app, choose **Stop simulation**, select **STM32 reference ECU**, arm the capture, then choose **Start simulation**. Watch for the firmware's rear-left wheel to drop from 40 to 30 km/h and brake pressure to reach 60 bar. In **Diagnostics**, choose **Software version** to see the request and response bytes. Stop the run before switching back to the dynamics model. The hosted Cloudflare classroom labels this option **Desktop and local app only**.

## Import and inspect a DBC definition

1. Open **DBC workbench** and choose **Load teaching example**, or choose **Import DBC file** for a local `.dbc` file. The definition is validated before it is saved in this browser profile. To create one without DBC syntax, open **Build a message visually**.
2. In the visual builder, enter a standard CAN identifier, message name and payload length. Add signals and place each one at a start byte. The payload bench highlights assigned bytes in cyan and collisions in orange. Choose **Create and save message** only after every signal fits.
3. Select a message and change its physical signal values. **Packet preview** shows the encoded payload byte by byte. You can edit that payload to see how the same definition decodes different raw values.
4. Choose **Inspect in classroom** to highlight the signal bytes and decoding rule in **Packet classroom**. **Download worksheet** exports the current message, payload, byte order, raw calculation, value, and unit.
5. Refresh the page to confirm the validated definition returns. **Clear local DBC** removes only that imported definition; it does not alter the built-in lab protocol.

The current teaching subset accepts standard 11-bit identifiers, 1–8 byte Classical CAN messages, and byte-aligned 8, 16, 24, or 32-bit integer signals. Intel and Motorola byte order, signedness, factor, offset, range, and unit are supported. Extended identifiers, CAN FD DBC messages, bit-packed signals, multiplexing, overlapping signals, and built-in lab identifiers are rejected rather than partially decoded. The workbench only creates local previews; it does not connect to or transmit through CAN hardware.

## Use a separate controls window

Choose **Detach controls** in the header. The main window presents the car or the selected lesson. Use **Drive** for the driving controls, **Body** for lamps and doors, **Receiver** for the two classroom cars, and **Analysis** for packet worksheets, ESC captures and diagnostics. In **Analysis**, the **Highlight signal** menu selects the bytes highlighted on the main screen.

The desktop app opens on Screen 2 when a second display is connected. **Show controls** brings the small window forward. **Dock controls** or closing the small window restores the inline controls while the run continues. In a browser, allow pop-ups for the studio if the small window is blocked.

## Keep your evidence

Use **Export JSON trace** in **Network analyzer** for the backend's most recent 3,000 frames. Stopping the simulation retains that trace. Download it before closing the backend, and use the event worksheet to keep a particular wheel-slip observation.

The receiver exercise can be resumed after a refresh in the same browser profile at the same address. On desktop, reopen the same app profile. **Reset exercise** starts a fresh receiver worksheet. If the header shows **Reconnecting**, wait for **Lab connected** before sending another control change. In the local web version, check that the studio server is still running if that message persists.
