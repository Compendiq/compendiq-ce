<script setup>
import { useData } from 'vitepress'
const { isDark } = useData()
</script>

# IDE-Integrationen

## VS Code <Badge>Offiziell</Badge> {#vs-code}

<p text-center>
<img :src="`https://raw.githubusercontent.com/vitest-dev/vscode/main/img/cover-${isDark ? 'light' : 'dark' }.png`" w-60 alt="vscode logo">
</p>

[GitHub](https://github.com/vitest-dev/vscode) | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vitest.explorer)

![Ein GIF der vscode-Erweiterung in vscode](https://i.ibb.co/bJCbCf2/202203292020.gif)

## JetBrains-IDEs

WebStorm, PhpStorm, IntelliJ IDEA Ultimate und andere JetBrains-IDEs bringen eine eingebaute Unterstützung für Vitest mit.

<p text-center>
<img :src="`/ide/vitest-jb-${isDark ? 'light' : 'dark'}.png`" w-60 alt="webstorm logo">
</p>

[WebStorm-Hilfe](https://www.jetbrains.com/help/webstorm/vitest.html) | [IntelliJ IDEA Ultimate-Hilfe](https://www.jetbrains.com/help/idea/vitest.html) | [PhpStorm-Hilfe](https://www.jetbrains.com/help/phpstorm/vitest.html)

![Vitest WebStorm Demo](https://raw.githubusercontent.com/kricact/WS-info/main/gifs/vitest-run-all.gif)

## Wallaby.js <Badge>Kostenpflichtig (kostenlos für OSS)</Badge>

Erstellt vom [Wallaby-Team](https://wallabyjs.com)

[Wallaby.js](https://wallabyjs.com) führt Ihre Vitest-Tests unmittelbar während des Tippens aus und hebt die Ergebnisse in Ihrer IDE direkt neben Ihrem Code hervor.

<p text-left>
  <img :src="`/ide/vitest-wallaby-${isDark ? 'light' : 'dark'}.png`" alt="Vitest + Wallaby logos" w-142>
</p>

[VS Code](https://marketplace.visualstudio.com/items?itemName=WallabyJs.wallaby-vscode) | [JetBrains](https://plugins.jetbrains.com/plugin/15742-wallaby) |
[Visual Studio](https://marketplace.visualstudio.com/items?itemName=vs-publisher-999439.WallabyjsforVisualStudio2022) | [Sublime Text](https://packagecontrol.io/packages/Wallaby)

![Wallaby VS Code Demo](https://wallabyjs.com/assets/img/vitest_demo.gif)
