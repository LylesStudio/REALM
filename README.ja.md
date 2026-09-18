# REALM

自分のパソコンで動かす、ひとり用の世界づくりゲームです。世界と会話すると、その世界は記憶を残し、少しずつ成長していきます。

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md)

![REALM WebUI 世界の入口](./public/screenshots/webui-home.ja.png)

デモ世界でキャラクターと進める様子（界面は日本語。世界内テキストの言語は世界の設定に従います）：

![REALM WebUI 記録ビュー](./public/screenshots/webui-record.ja.png)

> ランチャーをダブルクリックして案内に従うと、上の世界の入口がブラウザに開きます。初回起動時、ランチャーが不足している環境を確認し、インストール前に必ず確認します。

## とにかく遊びたい方へ

まだフォルダを持っていませんか？　ターミナルで1コマンドだけ実行すれば、取得からセットアップまで全部済みます（何かを入れる前に必ず確認します）。

**Linux / macOS（Apple Silicon）：**

```bash
curl -fsSL https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.sh | bash
```

Docker もシステムの PostgreSQL も入れたくない方は `--embedded-pg` を付けてください。プラットフォーム別の組み込み PostgreSQL 17+pgvector アーティファクト（linux-x64 / darwin-arm64 / windows-x64。GitHub Actions ビルド＋SHA256 チェックサム付き）を自動でダウンロードしてユーザーディレクトリに入れます。

```bash
curl -fsSL https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.sh | bash -s -- --embedded-pg
```

**Windows（PowerShell、x64）：**

```powershell
irm https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.ps1 | iex
```

組み込み PostgreSQL 付きの1コマンド：

```powershell
iex "& { $(irm https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.ps1) } -EmbeddedPg"
```

すでにクローン済みのフォルダ内なら、これだけでもOKです。

```bash
bash scripts/install.sh --embedded-pg   # Linux / macOS
.\scripts\install.ps1 -EmbeddedPg       # Windows PowerShell
```

> macOS は Apple Silicon（Mシリーズ）のみ対応です。Intel Mac の場合は Homebrew で PostgreSQL 17 + pgvector をインストールすれば、setup-web が自動で検出します。
> 上記 raw URL はリポジトリが Public になればすぐ使えます。Private の間は、まずクローンしてからローカルスクリプトを実行してください。

### アップグレード

**同じコマンドをもう一度実行するだけで完全アップグレードです**。インストーラーが最新ソースを取得し、依存関係を更新し、組み込み PostgreSQL のバージョンを比較します——最新ならスキップ、新バージョンがあればダウンロード→SHA256 検証→旧インストールをバックアップしながら差し替え（失敗時は自動ロールバック）。データベースはそのまま残ります。

```bash
curl -fsSL https://raw.githubusercontent.com/Silver-Aurora/REALM/main/scripts/install.sh | bash -s -- --embedded-pg
```

プログラムとデータは分離されています：実行ファイルは `~/.local/realm-pgsql/<バージョン>`、データベースは `~/.local/realm-pgsql/data` ——アップグレードは実行ファイルだけを差し替えます。

REALMのフォルダをすでに持っている場合は、OSに合わせて起動してください。

### Windows

次のファイルをダブルクリックします。

```text
START-REALM-Windows.cmd
```

PowerShellやセキュリティに関する確認が表示されたら、実行を許可してください。黒い画面の指示に従い、インストール確認が出たら `Y` を入力します。

### macOS

次のファイルをダブルクリックします。

```text
START-REALM.command
```

初回にmacOSが開くのを止めた場合は、Finderでファイルを右クリックし、「開く」を選んで確認してください。

### Linux

プロジェクトフォルダでターミナルを開き、次を実行します。

```bash
bash START-REALM-Linux.sh
```

ランチャーが次の処理を行います。

1. Node.jsとnpmを確認する
2. PostgreSQL/pgvectorまたはDockerを確認する
3. 足りないものを表示し、インストール前に確認する
4. ローカル設定を作る
5. ローカルデータベースを起動する
6. REALMを初期化し、デモ用の世界を読み込む
7. Webサーバーを起動し、ブラウザを開く

ブラウザにREALMが表示されたら遊び始められます。遊んでいる間はターミナルを閉じないでください。Webサーバーを止めるときは `Ctrl+C` を押します。

## 初回起動後：モデルを選ぶ

世界の生成やキャラクターの返答には、モデル提供元が必要です。起動後に設定ページを開き、次のいずれかを設定してください。

- LM Studioなどのローカルサービス。ローカルURLとモデル名を入力します。
- OpenAI互換サービス。URL、モデル名、API keyを入力します。
- モデルサービスがなくても画面やデモデータは見られますが、AIによる生成は動きません。

API keyは自分のパソコンのローカル設定にだけ保存してください。Issue、チャット、ログ、Gitには貼らないでください。

## 起動できないとき

プロジェクトフォルダで、まず読み取り専用の確認を実行します。

```bash
node scripts/setup-web.mjs --check
```

この確認は、環境のチェックだけを行います。インストール、設定変更、データベース起動は行いません。

よくあるケース：

- **Node.jsがない、または古い：**
  - macOS/Linux：`bash scripts/setup-web.sh` を実行します。Homebrewがあれば、確認後にNode.js 22をインストールできます。
  - Windows：`START-REALM-Windows.cmd` をダブルクリックするか、PowerShellで `scripts/setup-web.ps1` を実行します。wingetがあれば、確認後にNode.js LTSをインストールできます。
  - 新しいターミナルを開くように表示されたら、その通りにしてからランチャーをもう一度実行してください。
- **WindowsでDocker Desktopが起動していない：** Docker Desktopを起動し、準備が終わるまで待ってからランチャーをもう一度実行します。初回は利用規約の確認やWindowsの再起動が必要になる場合があります。
- **macOSにHomebrewがない：** [brew.sh](https://brew.sh)からHomebrewをインストールして、ランチャーをもう一度実行します。Docker Desktopを使う方法もあります。
- **ポートが使用中：** ランチャーが別のローカルポートを探します。ターミナルの最後に表示されたURLを使ってください。
- **ブラウザが自動で開かない：** 最後に表示された `http://127.0.0.1:...` をChrome、Edge、Safari、Firefoxに貼り付けます。
- **インストールに失敗した：** すぐにデータベースを削除しないでください。最後のエラーを保存し、ランチャーをもう一度実行します。可能な場合は既存のローカルデータを再利用します。

## データとプライバシー

REALMは初期状態では `127.0.0.1` にだけ接続します。LANやインターネットへ自動公開することはありません。

- Dockerモードでは、PostgreSQLのデータをローカルのDocker volumeに保存します。
- ローカルPostgreSQLモードでは、プロジェクト内のローカルデータディレクトリに保存します。
- `.env.local` はローカル設定です。Gitにはコミットしないでください。
- アプリのファイルを削除しても世界データは自動では消えません。先にバックアップしてください。

## 今すぐ遊べること

REALMは、会話、キャラクターの記憶、世界知識、Record単位のイベントを、読み返せるひとつの世界にまとめます。

- World / Story / Recordのナビゲーション
- 再開可能な会話ターンと、Recordごとの単一書き込み
- キャラクターの記憶、世界知識、シーンの結晶化、Canonレビュー
- ルール、ダイス、キャラクターの存在、自動世界シミュレーション
- PostgreSQL + pgvectorによる永続化
- 複数のモデル提供元設定と構造化出力の修復
- 紙とインクを思わせる矩形ベースの画面

## コマンドラインオプション

ターミナルに慣れている方は、次のコマンドを使えます。

```bash
# 変更せずに環境だけ確認
node scripts/setup-web.mjs --check

# 対話式のセットアップと起動（推奨）
node scripts/setup-web.mjs

# インストールとローカル設定の確認をすべて承認
node scripts/setup-web.mjs --yes

# ブラウザを自動で開かずに起動
node scripts/setup-web.mjs --no-open
```

`--yes` は、信頼できるパソコンとネットワークでだけ使用してください。通常は対話式モードのまま使う方が安全です。

## ドキュメント

- [Webブートストラップ](./docs/WEB-BOOTSTRAP.md)
- [詳しい始め方](./docs/GETTING-STARTED.md)
- [設定](./docs/CONFIGURATION.md)
- [セルフホストの範囲](./docs/SELF-HOSTING.md)
- [デスクトップ版プレビュー](./docs/DESKTOP-INSTALLATION.md)
- [システム設計](./docs/architecture/SYSTEM-DESIGN.md)

## 開発者向けの確認

```bash
npm test
npm run lint
npm run typecheck
```

全テストでは使い捨てのPostgreSQL scratchクラスタを使います。個人用または本番データベースへ接続してはいけません。

## ライセンス

REALMは [Apache-2.0 License](./LICENSE)で公開されています。
