# IoT Dice

IoT Diceは、サイコロの姿勢をBluetooth Low Energyでブラウザへ送り、3Dのサイコロとして表示するプロジェクトです。
nRF5340とBNO085から取得した姿勢情報を、Web Bluetooth対応のWebアプリで可視化します。

Webアプリは[GitHub Pages](https://liesegang.github.io/iot_dice/)で公開しています。

## 動作モード

通常は姿勢共有モードで動作します。
サイコロから約50 Hzで姿勢情報だけを送り、ブラウザ上の3D表示へ反映します。

Webアプリで「シミュレーション」を有効にすると、投擲状態、衝撃、出目などの情報も送信します。
このモードでは、Rapierを使ったモンテカルロシミュレーションによる出目予測と、計測データの記録・書き出しを利用できます。

## ディレクトリ構成

```text
firmware/  nRF5340用ファームウェア
software/  Web Bluetooth対応Webアプリ
hardware/  基板データと回路図
```

## ファームウェア

### 必要なもの

- nRF Connect SDK 3.4.0
- nRF5340 DK
- BNO085

nRF Connect SDKのターミナルで、リポジトリのルートから次のコマンドを実行します。

```sh
west build -b nrf5340dk/nrf5340/cpuapp --sysbuild -d firmware/build firmware
west flash -d firmware/build
```

`--sysbuild`により、nRF5340のネットワークコア用`hci_ipc`も同時にビルドされます。
VS CodeのnRF Connect拡張機能を使う場合は、アプリケーションのディレクトリに`firmware`を指定してください。
公式の拡張機能一式は[Nordic SemiconductorのnRF Connect for VS Code Extension Pack](https://marketplace.visualstudio.com/items?itemName=nordic-semiconductor.nrf-connect-extension-pack)です。

## Webアプリ

```sh
cd software
npm ci
npm run dev
```

配布用ファイルは次のコマンドで生成します。

```sh
npm run build
```

Web Bluetoothを利用するため、ChromeまたはEdgeでHTTPSのページ、もしくは`localhost`を開いてください。
ページ上の接続ボタンから、Bluetoothデバイス名`dice`を選択します。

## ハードウェア

基板データは`hardware/iot_dice.brd`、回路図は`hardware/iot_dice.sch`にあります。

電源パッドはTH1が`+3V3`、TH2が`GND`です。この基板には電池用の降圧回路がなく、TH1はBNO085のVDD/VDDIOとnRF5340モジュールのVDD/VDDHへ直接つながっています。
1セルLiPo（公称3.7V、満充電4.2V）を直結せず、3.3Vに安定化した電源を使用してください。
BNO085のVDDIOは推奨動作上限3.6V、絶対最大定格3.63Vです（[データシート §6.1–6.2](https://www.ceva-ip.com/wp-content/uploads/BNO080_085-Datasheet.pdf)）。

J-Linkの標準VTrefは基板の電圧を受け取る入力端子です（[SEGGERの公式説明](https://kb.segger.com/VTref)）。
給電アダプターを使用しない標準の接続では、外部の安定化3.3V電源をTH1/TH2へ接続し、基板の`+3V3`をVTrefへ、`GND`をJ-LinkのGNDへ接続します。
標準20ピンコネクタの19番にある給電出力は5Vなので、この基板のTH1へ直結できません（[J-Linkのピン仕様](https://kb.segger.com/20-pin_J-Link_Connector)）。

基板の6ピンコネクタCON1は次の配列です。ピン番号はJ-Linkの標準20ピンコネクタとは異なります。

| CON1のピン | 信号 |
| --- | --- |
| 1 | NRST |
| 2 | +3V3 |
| 3 | SWDIO |
| 4 | GND |
| 5 | SWCLK |
| 6 | 未接続 |
