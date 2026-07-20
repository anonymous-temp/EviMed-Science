package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.codec.Base64;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.utils.operateyl.HttpUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.exception.ExceptionUtils;

import java.io.*;
import java.util.*;
import java.util.Objects;

@Slf4j
public class EchartsUtils {
    private final String url;

    public EchartsUtils(String url) {
        this.url = url;
    }

    private static final String SUCCESS_CODE = "1";
    private final static List<String> stopList = Arrays.asList("accidental exposure to product","accidental overdose","adverse drug reaction","adverse event","application site irritation","condition aggravated","coordination abnormal","discomfort","disease recurrence","dissociation","drug effective for unapproved indication","drug ineffective for unapproved indication","drug resistance","extra dose administered","hospitalisation","illness","incorrect product administration duration","incorrect route of product administration","intentional overdose","intentional product use issue","medication error","needle issue","neoplasm progression","prescribed overdose","prescribed underdose","product administration error","product complaint","product dispensing error","product name confusion","product odour abnormal","product physical issue","product prescribing error","product storage error","product substitution issue","ther apeutic product effect decreased","therapeutic product effect incomplete","therapeutic response decreased","therapy non-responder","transfusion","treatment failure","underdose","wrong technique in device usage process");

    /**
     * base64字符串转化成图片
     *
     * @param imgData     图片编码
     * @param imgFilePath 存放到本地路径
     * @return 是否转换成功
     */
    public boolean generateImage(String imgData, String imgFilePath) throws IOException {
        // 对字节数组字符串进行Base64解码并生成图片
        if (imgData == null) {
            // 图像数据为空
            return false;
        }
        Base64 decoder = new Base64();
        OutputStream out = null;
        try {
            out = new FileOutputStream(imgFilePath);
            // Base64解码
//            byte[] b = imgData.getBytes(StandardCharsets.UTF_8);
            byte[] b = decoder.decode(imgData);
            for (int i = 0; i < b.length; ++i) {
                if (b[i] < 0) {
                    // 调整异常数据
                    b[i] += 256;
                }
            }
            out.write(b);
        } catch (IOException e) {
            e.printStackTrace();
        } finally {
            Objects.requireNonNull(out).flush();
            out.close();
        }
        return true;
    }


    /***
     * 将option字符串作为参数发送给echartsConvert服务器
     * @param option option 参数
     * @return 图片的base64字符串
     */
    private String createImage(JSONObject option) {
        Map<String, String> params = new HashMap<>();
        String str = option.toJSONString().replaceAll("\\s+", "").replaceAll("\"", "'");
        params.put("opt", str);
        try {
            String response = HttpUtils.post(url, params, "utf-8");
            JSONObject responseJson = JSON.parseObject(response);
            String code = responseJson.getString("code");
            String base64;
            if (SUCCESS_CODE.equals(code)) {
                base64 = responseJson.getString("data");
            } else {
                String string = responseJson.getString("msg");
                throw new RuntimeException(string);
            }
            return base64;

        } catch (Exception e) {
            log.error("生成图片出现异常=={}", ExceptionUtils.getFullStackTrace(e));
            //throw new BizException(500, e.getMessage());
            return "";
        }
    }
    
    /***
     * 根据提供的饼图数据，拼接option，然后调用echarts生成饼图，获得图片的base64字符串
     * @param data 饼图数据
     * @return 图片的base64字符串
     */
    public String createPieChartImage(Map<String, Object> data, String chartType) {
        JSONObject option = new JSONObject();
        
        option.put("legend", new JSONObject());
        option.getJSONObject("legend").put("orient", "vertical");
        option.getJSONObject("legend").put("left", "right");
        option.getJSONObject("legend").put("show", Optional.of(true));
        option.getJSONObject("legend").put("top", "20%");
        option.getJSONObject("legend").put("right", "15%");
        option.getJSONObject("legend").put("data", data.get("legend"));
        option.put("series", new JSONArray());
        option.getJSONArray("series").add(new JSONObject());
        option.getJSONArray("series").getJSONObject(0).put("label", new JSONObject());
        option.getJSONArray("series").getJSONObject(0).put("labelLine", new JSONObject());
        option.getJSONArray("series").getJSONObject(0).put("data", data.get("data"));
        option.getJSONArray("series").getJSONObject(0).put("type", chartType);
        option.getJSONArray("series").getJSONObject(0).getJSONObject("label").put("show", Optional.of(true));
        option.getJSONArray("series").getJSONObject(0).getJSONObject("label").put("formatter", "{d}%");
        option.getJSONArray("series").getJSONObject(0).getJSONObject("labelLine").put("show", Optional.of(true));

        return createImage(option);
    }

//    public Option getBarData(JSONArray photo) {
//        List<String> name_x = new ArrayList<>();
//        List<String> value_y = new ArrayList<>(Arrays.asList("0","5000","10000","15000","20000","25000","30000","35000","40000","45000"));
//        List<String> name_x_value = new ArrayList<>();
//        for (int i = 0; i < photo.size(); i++) {
//            JSONObject jsonObject = photo.getJSONObject(i);
//            name_x.add(jsonObject.getString("name"));
//            name_x_value.add(jsonObject.getString("num"));
//        }
//
//        Bar bar = new Bar();
//        
//        GsonOption option = new GsonOption();
//        
//        option.title().text("严重不良反应结局分布图").textStyle().fontFamily("宋体");
//        
//        Legend legend = new Legend();
//        legend.data("严重不良反应结局分布图");
//        option.legend(legend);
//        
//        option.calculable(true);
//        
//        // 设置x轴刻度标签
//        CategoryAxis categoryAxis = new CategoryAxis();
//        categoryAxis.setData(name_x);
////        categoryAxis.data(1,2,3,4,5,6);
////        categoryAxis.axisLabel().textStyle().fontFamily("微软雅黑");
//        categoryAxis.axisLabel().interval(0);
//        categoryAxis.axisLabel().rotate(90);
//        option.xAxis(new CategoryAxis().boundaryGap(false).data("你","我","我分","我的","我额","我个"));
//
//        // y轴刻度
//        ValueAxis yxis = new ValueAxis();
//        yxis.name("数量");
//        yxis.setData(value_y);
//        option.yAxis(yxis);
//
//        
//        bar.setData(name_x_value);
//        option.series(bar);
//        
//        option.color(Arrays.asList("#6E7EBA", "#9BACEA", "#BFC8EC"));
//        
//        Grid grid = new Grid();
//        grid.setWidth(200);
//        grid.setHeight(100);
//        option.setGrid(grid);
//
//        return option;
//    }
    

    /**
     * 调用echarts生成柱状图
     * @param photoData 数据
     * @return base64格式的图片
     */
    public String createCategory(JSONArray photoData) {
        List<String> x = new ArrayList<>();
        List<Long> y = new ArrayList<>();
        for (int i = 0; i < photoData.size(); i++) {
            JSONObject jsonObject = photoData.getJSONObject(i);
            String name = jsonObject.getString("name");
            x.add(name);
            Long num = jsonObject.getLong("num");
            y.add(num);
        }
        JSONObject option = new JSONObject();
        option.put("xAxis", new JSONObject());
        option.getJSONObject("xAxis").put("type", "category");
        option.getJSONObject("xAxis").put("axisLabel", new JSONObject());
        option.getJSONObject("xAxis").getJSONObject("axisLabel").put("interval", 0);
        option.getJSONObject("xAxis").getJSONObject("axisLabel").put("rotate", 38);
        option.getJSONObject("xAxis").put("data", x);
        option.put("yAxis", new JSONObject());
        option.getJSONObject("yAxis").put("type", "value");
        option.put("series", new JSONArray());
        option.getJSONArray("series").add(new JSONObject());
        option.getJSONArray("series").getJSONObject(0).put("data", y);
        option.getJSONArray("series").getJSONObject(0).put("type", "bar");
        return createImage(option);
    }
}
