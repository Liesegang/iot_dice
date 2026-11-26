# IoT Dice

サイコロの姿勢・IMUデータをBluetooth Low Energyでブラウザに送り、3D表示するプロジェクトです。

| バージョン | MCU | IMU |
| --- | --- | --- |
| [v1](v1/README.md) | nRF5340 | BNO085 |
| [v2](v2/README.md) | nRF54L15 / ES4L15BA1 | LSM6DSV320X |

```text
v1/
  firmware/  nRF5340用
  hardware/  旧基板データ・回路図
  software/  v1 Webアプリ
v2/
  firmware/  nRF54L15用
  hardware/  Dice 2a基板データ・回路図
  software/  v2 Webアプリ
```

v2では電源投入後にLED2が点滅し、BLE接続中にLED1が点灯します。LSM6DSV320XはLow-gを±16g・120 Hz、High-gを±320g・960 Hz、角速度を±4000dpsに設定しています。High-gはFIFOから取得し、通知間の衝突ピークを保持します。BLE通知は通常約60 Hz、予測／軌跡モードは最大120 Hzです。Web画面では角速度・Low-g・High-g・重力除去後の加速度を4グラフで表示します。

WebアプリはChromeまたはEdgeのHTTPS / localhostで使えます。

```sh
cd v2/software
npm ci
npm run dev -- --host localhost
```

表示されたURLを開き、「サイコロを接続」から`dice`を選んでください。同名デバイスが複数ある場合は対象基板のアドレスで識別します。

GitHub Pagesのワークフローはv1・v2を両方ビルドし、次回デプロイ時にはルートと`/v2/`でv2、`/v1/`でv1を公開します。ファームウェアのビルド・書き込み手順と配線は各バージョンのREADMEを参照してください。
