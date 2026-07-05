# 單字小夥伴 Word Buddy 🐣

給小朋友的英文學習 PWA：學單字 → 造句子 → 練發音，全程繁體中文引導。

## 功能

1. **學單字**：輸入英文單字，自動查字典（音標、詞性、定義、標準發音）；拼錯會給建議
2. **造句子**：文法檢查，錯誤用中文解釋，點一下建議就能修正
3. **練發音**：語音辨識逐字比對，唸錯的字標紅、可單獨聽標準讀音，全對過關拿星星 ⭐
4. **單字本**：學過的單字與句子都記錄在裝置上（localStorage）

## 技術

純前端靜態網站（無框架、無後端），全部使用免費服務：

- [Free Dictionary API](https://dictionaryapi.dev/) — 單字定義與發音
- [Datamuse API](https://www.datamuse.com/api/) — 拼字建議
- [LanguageTool](https://languagetool.org/) 公開 API — 文法檢查
- 瀏覽器內建 speechSynthesis（朗讀）與 SpeechRecognition（語音辨識）

## 本機執行

```bash
python3 serve.py
# 開啟 http://127.0.0.1:8899
```

## 使用提醒

- 語音辨識需要 HTTPS 與麥克風權限；iPhone 請用 **Safari** 開啟（LINE 內建瀏覽器不支援）
- 手機開啟網頁後可「加入主畫面」，即可像 App 一樣全螢幕使用
