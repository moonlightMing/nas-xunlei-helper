import { createApp, h } from 'vue';
import Antd, { ConfigProvider } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import 'ant-design-vue/dist/reset.css';
import './style.css';
import App from './App.vue';

const app = createApp({
  render: () => h(ConfigProvider, { locale: zhCN }, () => h(App)),
});
app.use(Antd);
app.mount('#app');
