const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  mode: 'development',
  devServer: {
    static: [
      { directory: path.join(__dirname, 'dist') },
      { directory: path.resolve(__dirname, '..'), publicPath: '/..' }, // serve parent to access market_data.json if needed
      { directory: __dirname, publicPath: '/' } // serve current dir
    ],
    compress: true,
    port: 9000,
    hot: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'Rapid-EA ChartGPU Viewer',
      template: './src/index.html',
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
};
