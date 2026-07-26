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
