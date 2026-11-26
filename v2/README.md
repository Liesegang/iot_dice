# IoT Dice v2 / Dice 2a

KAGA FEI ES4L15BA1（nRF54L15）とLSM6DSV320Xを使う基板です。部品はCADの`PARTS=LSM6DSV320XTR`と実機の`WHO_AM_I=0x73`で識別しています。IC1のdeviceset名はLSM6DSV16XTRのままなので、ドライバー選択には使いません。

## 動作

- LED2（P1.00）：起動直後から500 msごとにON/OFF。IMU初期化が失敗しても点滅します。
- LED1（P1.01）：BLE接続中に点灯、切断時に消灯。
- IMU設定：Low-gは±16g・120 Hz、High-gは±320g・960 Hz、角速度は±4000dps・120 Hz。通常は約60 Hz、軌跡／予測モードは最大120 HzでBLE通知。
- 通常モード：姿勢・角速度・重力除去後の加速度・Low-g／High-g生値と通知間のHigh-gピークを送信。
- 予測モード：最初の衝突前の状態と時刻・投擲番号を送信し、Webで15 mmのサイコロの出目を予測します。実機記録を使う強化学習と検証・テスト評価を追加しました。現時点では必要数の学習用記録が揃っておらず、モデルは未学習・精度未検証です。

SFLPのGame Rotationは磁気センサーを使わないため、ヨーの絶対方位は任意でドリフトすることがあります。

## 配線

| 用途 | nRF54L15 GPIO | モジュールパッド |
| --- | --- | --- |
| LED1 / BLE | P1.01 | 3 |
| LED2 / 起動 | P1.00 | 4 |
| IMU SCK | P2.04 | 9 |
| IMU MOSI | P0.03 | 8 |
| IMU MISO | P0.04 | 7 |
| IMU CS | P2.01 | 10 |
| IMU INT1（未使用） | P1.03 | 5 |

SPIはZephyrのGPIO bitbang、mode 3、設定上限500 kHzです。SCKとデータ線がP2/P0に分かれているため、この配線のまま単一のハードウェアSPIMでは駆動できません。実際の速度はGPIO操作の処理時間にも依存します。FIFOをポーリングします。

P1.00/P1.01をLEDに使うため、低周波クロックは校正ありの内部RCを使用します。電源は安定化された3.3Vを使用してください。

| CON1ピン | 信号 |
| --- | --- |
| 1 | NRST |
| 2 | +3V3 |
| 3 | SWDIO |
| 4 | GND |
| 5 | SWCLK |
| 6 | 未接続 |

基板・回路図は[hardware](hardware/)にあります。`.fbrd` / `.fsch`は元のFusionファイル、`.brd` / `.sch`は取り出したEagle XMLです。

## ビルド・書き込み

nRF Connect SDK 3.4.0の環境で、リポジトリのルートから実行します。

```sh
west build -b nrf54l15dk/nrf54l15/cpuapp -d v2/firmware/build v2/firmware
```

SDKのDKターゲットに`app.overlay`で実基板の配線を適用します。v1用HEXやネットワークコア用ファームウェアはこの基板へ書き込まないでください。

J-Linkとnrfutil deviceを使う場合は対象シリアル番号を確認してから書き込みます。

```sh
nrfutil device list
nrfutil device program \
  --firmware v2/firmware/build/firmware/zephyr/zephyr.hex \
  --serial-number <J-Linkのシリアル番号> \
  --family nrf54l --swd-clock-frequency 1000 \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ,reset=RESET_DEFAULT
```

全消去を使わず、HEXに含まれるコード領域だけを書き込みます。RTTログとELFの`app_debug`シンボルで診断できます。SWDで`app_debug`を読む際、MCUを停止させる必要はありません。

## 姿勢デコードとBLE

LSM6DSV320XのSFLP FIFOは姿勢1件を`[0x0000, X, Y]`、`[0x0001, Z, W]`の2レコードで出力します。X/Y/Z/Wは符号付きbinary16です。2件が揃ってから4成分を正規化し、Wの符号も使います。[STの公式FIFO例](https://github.com/STMicroelectronics/STMems_Standard_C_drivers/blob/master/lsm6dsv320x_STdC/examples/lsm6dsv320x_read_fifo.c)を参照してください。

BLE名は`dice`、サービスUUIDは`d1ce0001-1234-5678-abcd-1234567890ab`。通知UUIDは先頭部分が`d1ce0002`、操作UUIDは`d1ce0003`です。

v3の姿勢／ストリーム通知は100バイトです。従来の58バイトの先頭に続き、Low-g生値、High-g最新値、通知間のHigh-g最大ベクトル、有効性・飽和フラグを含みます。通常モードの速度は0です。衝突通知は76バイト、静止通知は44バイトで、High-gの衝突ピークや最大値を記録します。多バイト値はlittle-endianです。詳細は[ble_orient.hpp](firmware/src/ble_orient.hpp)。Webアプリは従来の22/46/58バイト姿勢、50/58バイト衝突、32/36バイト静止も読めます。High-gが届いていない場合は「未受信」と表示します。

## Webアプリとテスト

```sh
cd v2/software
npm ci
npm run dev -- --host localhost
```

配布用ビルドは`npm run build`、型チェックは`npx tsc --noEmit`、BLE・物理モデル・強化学習の回帰テストは`npm test`です。

投擲の記録、6面校正、学習、モデルの保存と再学習については[software/LEARNING.md](software/LEARNING.md)を参照してください。

姿勢FIFOの回帰テストはSDKのSTドライバーをホスト向けにリンクして実行します。左右の符号、180度を超えた回転、2レコードの組み立て、欠損・不正データからの復帰を検証します。

```sh
STMEMSC_DRIVER_DIR=/opt/nordic/ncs/v3.4.0/modules/hal/st/sensor/stmemsc/lsm6dsv320x_STdC/driver \
  sh v2/firmware/tests/run.sh
```

### 推定軌跡の表示

Web画面の「軌跡 ON」で、静止位置を原点にした相対移動を水色の線で表示します。黄色の点が原点です。X/YはIMUの水平軸（向きは任意）、Zは上向きで、移動量はcm表示です。軌跡の取得に面校正や出目予測のONは不要です。静止を検出すると線を消し、次に動き始めると原点を更新します。センサーの微小な揺れや残留速度では線を生成しません。「軌跡を消す」で手動リセットできます。

位置はファームウェアの推定速度をデバイス時刻で積分した値です。外部の位置計測ではなく、IMU誤差の影響を受けます。8秒までの短い動きを対象とし、250msを超える受信の空白では線を消して積分を止め、次の静止を待ちます。軌跡ON中は予測OFFでも速度付きの通知モードを使いますが、学習記録は予測ONの場合だけ保存します。


### 校正表示・IMUグラフ・学習状態

6面の校正は出目判定と3D描画の両方に反映します。表示はサイコロからIMUへの取付回転を掛け、逆の番号配置では面1と6の材質を交換します。静止が300ms以上続いている場合のみ校正でき、不正な面の組み合わせは採用しません。左上に実機の推定上面を表示します。

右上のIMU波形は直近10秒のX/Y/Z角速度（rad/s）、Low-g生加速度（g）、通知間のHigh-gピーク（g）、重力除去後の加速度（m/s²）の4図です。通信が途切れた部分は線をつなぎません。これらはIMU座標系の値です。

学習の実行状況は左上と学習パネルで確認できます。パネルには学習可能な記録数、不足数、校正前・ジャイロ飽和で除外された確認済み記録数、最終実行時刻とモデル採用結果を表示します。正解未確認の記録は学習されません。過去の記録は「未確認の記録に正解を付ける」から、実際の出目を覚えているものだけ確認できます。


### High-gでの衝突取得

Low-gは±16g・120Hz設定で姿勢・静止判定・速度の推定に使います。High-gは±320g・960Hz設定でFIFOへ保存し、通知間の全サンプルから最大ノルムの符号付きベクトルを残します。低速のBLE通知でも、サンプル済みの短い衝突ピークが表示されます。IMUのサンプル間に収まる衝撃まで保証するものではありません。

現在の実機では、MCUの時刻に基づく姿勢取得は約111 Hz、High-g取得は約887 Hzで、High-gは姿勢の約8倍でした。120／960 Hzは設定値で、これらの実測値やBLE通知速度とは異なります。

High-gの重力除去後のピークを初回衝突判定へ反映し、着地結果には投擲中の最大High-gと飽和判定回数を保存します。姿勢予測の入力は従来どおり初回衝突前の姿勢・角速度・速度で、衝突ピークを予測入力に混ぜません。High-gのピーク時刻はFIFOから取り出した際のMCUのuptimeです。厳密なセンサー採取時刻ではありません。

ジャイロは±4000dpsへ拡大し、換算と飽和閾値を合わせています。過去の±2000dps時の飽和記録は元の情報を維持します。高gのゼロ点精度はLow-gより低いため、小さい動きと静止にはLow-gを使います。
