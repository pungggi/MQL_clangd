const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  mode: 'production',
  devtool: 'hidden-source-map',
  devServer: {
    static: [
      { directory: __dirname, publicPath: '/' } // serve current dir only
    ],
    compress: true,
    port: 9000,
    hot: true,
    proxy: {
      '/market_data.json': {
        target: 'http://localhost:9000',
        pathRewrite: { '^/market_data.json': '/market_data.json' }
      }
    }
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'Rapid-EA Strategy Viewer',
      template: './src/index.html',
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
};
