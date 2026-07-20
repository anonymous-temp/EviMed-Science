package com.sentum.drugsafe.controller;

import cn.hutool.core.io.FileUtil;
import cn.hutool.poi.excel.ExcelReader;
import cn.hutool.poi.excel.ExcelUtil;
import com.alibaba.fastjson.JSONObject;
import com.itextpdf.text.DocumentException;
import com.sentum.drugsafe.enums.TableEnum;
import com.sentum.drugsafe.pojo.Adrs;
import com.sentum.drugsafe.pojo.AssociationalWord;
import com.sentum.drugsafe.pojo.DrugNameWords;
import com.sentum.drugsafe.pojo.PicoResult;
import com.sentum.drugsafe.service.AlertService;
import com.sentum.drugsafe.trans.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.IndexOperations;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Api
@RestController
@RequestMapping("/alert")
public class AlertController {
    @Autowired
    private AlertService alertService;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    @ApiOperation(value = "药物警戒判断输入条件的类型，并将处理后的数据存储；返回值id用于后续接口的调用、type判断输入条件的类型，type=1，i+o、type=2，i、type=3，0调用findIForOnlyO接口获得药品列表", notes = "analyse")
    @ApiImplicitParam(name = "condition", value = "药物警戒用户输入的检索条件", required = true)
    @GetMapping("/analyse")
    public PicoResult analyse(String condition, HttpServletRequest request){
        String token = request.getHeader("token");
        Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
        assert redis != null;
        JSONObject redisMap = JSONObject.parseObject(redis.toString());
        long userId = Long.parseLong(redisMap.get("userId").toString());
        return PicoResult.data(alertService.analyse(condition, userId));
    }

    @ApiOperation(value = "analyse接口返回值type=3时调用，获得药品列表 --- pc", notes = "findIForOnlyO")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true),
            @ApiImplicitParam(name = "searchData", value = "检索框检索输入字段"),
            @ApiImplicitParam(name = "pageSize", value = "每页大小，默认10", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页，默认1", required = true),
            @ApiImplicitParam(name = "sort", value = "排序1-正序；2-倒叙，默认0", required = true)
    })
    @GetMapping("/findIForOnlyO")
    public PicoResult findIForOnlyO(String id, String searchData, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum, @RequestParam(defaultValue = "0") Integer sort){
        return PicoResult.data(alertService.findIForOnlyO(id, searchData, pageSize, pageNum, sort));
    }

    @ApiOperation(value = "analyse接口返回值type=3时调用，获得药品列表 --- App", notes = "findIForOnlyOApp")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true),
            @ApiImplicitParam(name = "searchData", value = "检索框检索输入字段"),
            @ApiImplicitParam(name = "pageSize", value = "每页大小，默认10", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页，默认1", required = true),
            @ApiImplicitParam(name = "choice", value = "非必传字段，不传值时典型/非典型信号同时查询；=1时典型信号，=0时非典型信号")
    })
    @GetMapping("/findIForOnlyOApp")
    public PicoResult findIForOnlyOApp(String id, String searchData, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum, Integer choice){
        return PicoResult.data(alertService.findIForOnlyOApp(id, searchData, pageSize, pageNum, choice));
    }

    @ApiOperation(value = "分析综述", notes = "analysisOverview")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true),
            @ApiImplicitParam(name = "type", value = "type=1 fda type=2 vigi", required = true),
    })
    @GetMapping("/analysisOverview")
    public PicoResult analysisOverview(String id, @RequestParam(defaultValue = "1") Integer type){
        return PicoResult.data(alertService.analysisOverview(id, type));
    }

    @ApiOperation(value = "药物警戒数据查询接口，综合性总接口", notes = "searchAll")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true),
            @ApiImplicitParam(name = "type", value = "type=1 fda；type=2 vigi")
    })
    @GetMapping("/searchAll")
    public PicoResult searchAll(String id, Integer type, HttpServletRequest request, HttpServletResponse response){
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return PicoResult.error(401, "token can't null or empty string");
        }
        return PicoResult.data(alertService.searchAll(id, type));
    }

    @ApiOperation(value = "下载药物警戒报告", notes = "download")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true),
    })
    @GetMapping("/download")
    public void download(String id, HttpServletResponse response){
        try {
            alertService.download(id, response);
        } catch (DocumentException | IOException e) {
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "下载word版本药物警戒报告", notes = "download")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索所用的id", required = true)
    })
    @GetMapping("/downloadWord")
    public void downloadWord(String id, HttpServletResponse response, HttpServletRequest request){
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return;
        }
        try {
            alertService.downloadWord(id, response);
        } catch (DocumentException | IOException | com.lowagie.text.DocumentException e) {
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "药物警戒显示用户的历史记录", notes = "showHistory")
    @GetMapping("/showHistory")
    public PicoResult showHistory(HttpServletRequest request,String type){
        String token = request.getHeader("token");
        Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
        assert redis != null;
        JSONObject redisMap = JSONObject.parseObject(redis.toString());
        long userId = Long.parseLong(redisMap.get("userId").toString());
        return PicoResult.data(alertService.showHistory(userId,type));
    }

    @ApiOperation(value = "根据历史记录的id删除当前历史记录", notes = "deleteHistory")
    @ApiImplicitParams({
    @ApiImplicitParam(name = "ids", value = "历史记录的id", required = false),
    @ApiImplicitParam(name = "id", value = "历史记录的id", required = false)})
    @GetMapping("/deleteHistory")
    public PicoResult deleteHistory(String ids,String id){
        if (StringUtils.isEmpty(ids)){
            ids = id;
        }
        return PicoResult.data(alertService.deleteHistory(ids));
    }

    @ApiOperation(value = "清空历史记录", notes = "emptyHistory")
    @GetMapping("/emptyHistory")
    public PicoResult emptyHistory(HttpServletRequest request){
        String token = request.getHeader("token");
        Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
        assert redis != null;
        JSONObject redisMap = JSONObject.parseObject(redis.toString());
        long userId = Long.parseLong(redisMap.get("userId").toString());
        return PicoResult.data(alertService.emptyHistory(userId));
    }

    @ApiOperation(value = "联想词", notes = "getAssociationalWord")
    @ApiImplicitParam(name = "word", value = "用户输入框输入词", required = true)
    @GetMapping("/getAssociationalWord")
    public PicoResult getAssociationalWord(String word){
        return PicoResult.data(alertService.getAssociationalWord(word));
    }



    /**
     * 将adrs表转化为小写
     */
    @GetMapping("/changeToLowercase")
    public void changeToLowercase(){
        long count = mongoTemplate.count(new Query(), Adrs.class);
        int pageSize = 1000;
        int num = (int) (count%pageSize == 0 ? count/pageSize : count/pageSize+1);
        for (int i = 0; i < num; i++) {
            Query query = new Query();
            query.with(PageRequest.of(i, pageSize));
            List<Adrs> adrsList = mongoTemplate.find(query, Adrs.class);
            List<Adrs> result = new ArrayList<>();
            for (Adrs adrs : adrsList) {
                adrs.setDescription(adrs.getDescription().toLowerCase());
                adrs.setIndicator(adrs.getIndicator() == null ? "-" : adrs.getIndicator());
                result.add(adrs);
            }
            mongoTemplate.insert(result, "adrs_lower");
        }
    }

    /**
     * 将excel中的数据同步到es中作为联想词
     */
    @GetMapping("/insertAssociationalWord")
    public void insertAssociationalWord(){
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AssociationalWord.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AssociationalWord.class));
        if (indexResult && mappingResult) {
            //不良反应翻译汇总-20211221(1).xlsx
            List<AssociationalWord> list1 = new ArrayList<>();
            ExcelReader reader1 = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\不良反应翻译汇总-20211221(1).xlsx"), 0);
            List<Map<String, Object>> data1 = reader1.readAll();
            for (Map<String, Object> map : data1) {
                String adRs = map.get("ADRs").toString();
                if (StringUtils.isNotBlank(adRs)) {
                    list1.add(new AssociationalWord(UUID.randomUUID().toString(), adRs.toLowerCase(), adRs.length()));
                }
                String adRsZh = map.get("不良反应").toString();
                if (StringUtils.isNotBlank(adRsZh)) {
                    list1.add(new AssociationalWord(UUID.randomUUID().toString(), adRsZh.toLowerCase(), adRsZh.length()));
                }
            }
            elasticsearchRestTemplate.save(list1);
            System.out.println("[不良反应翻译汇总-20211221(1).xlsx]写入完成");
            //translate_data.xlsx
            List<AssociationalWord> list2 = new ArrayList<>();
            ExcelReader reader2 = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\translate_data.xlsx"), 0);
            List<Map<String, Object>> data2 = reader2.readAll();
            for (Map<String, Object> map : data2) {
                String adRs = map.get("english_word").toString();
                if (StringUtils.isNotBlank(adRs)) {
                    list2.add(new AssociationalWord(UUID.randomUUID().toString(), adRs.toLowerCase(), adRs.length()));
                }
                String adRsZh = map.get("translate_word").toString();
                if (StringUtils.isNotBlank(adRsZh)) {
                    list2.add(new AssociationalWord(UUID.randomUUID().toString(), adRsZh.toLowerCase(), adRsZh.length()));
                }
            }
            elasticsearchRestTemplate.save(list2);
            System.out.println("[translate_data.xlsx]写入完成");
            //translate_data_3.xlsx
            List<AssociationalWord> list3 = new ArrayList<>();
            ExcelReader reader3 = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\translate_data_3.xlsx"), 0);
            List<Map<String, Object>> data3 = reader3.readAll();
            for (Map<String, Object> map : data3) {
                String adRs = map.get("english_word").toString();
                if (StringUtils.isNotBlank(adRs)) {
                    list3.add(new AssociationalWord(UUID.randomUUID().toString(), adRs.toLowerCase(), adRs.length()));
                }
                String adRsZh = map.get("translate_word").toString();
                if (StringUtils.isNotBlank(adRsZh)) {
                    list3.add(new AssociationalWord(UUID.randomUUID().toString(), adRsZh.toLowerCase(), adRsZh.length()));
                }
            }
            elasticsearchRestTemplate.save(list3);
            System.out.println("[translate_data_3.xlsx]写入完成");
            //translate_data_4.xlsx
            List<AssociationalWord> list4 = new ArrayList<>();
            ExcelReader reader4 = ExcelUtil.getReader(FileUtil.file("C:\\Users\\Admin\\Desktop\\translate_data_4.xlsx"), 0);
            List<Map<String, Object>> data4 = reader4.readAll();
            for (Map<String, Object> map : data4) {
                String adRs = map.get("english_word").toString();
                if (StringUtils.isNotBlank(adRs)) {
                    list4.add(new AssociationalWord(UUID.randomUUID().toString(), adRs.toLowerCase(), adRs.length()));
                }
                String adRsZh = map.get("translate_word").toString();
                if (StringUtils.isNotBlank(adRsZh)) {
                    list4.add(new AssociationalWord(UUID.randomUUID().toString(), adRsZh.toLowerCase(), adRsZh.length()));
                }
            }
            elasticsearchRestTemplate.save(list4);
            System.out.println("[translate_data_4.xlsx]写入完成");
            //drug_name_words
            List<AssociationalWord> list5 = new ArrayList<>();
            List<DrugNameWords> drugNameWords = mongoTemplate.findAll(DrugNameWords.class, TableEnum.DrugNameWords.getMsg());
            for (DrugNameWords drugNameWord : drugNameWords) {
                String standardName = drugNameWord.getStandardName();
                if (StringUtils.isNotBlank(standardName)) {
                    list5.add(new AssociationalWord(UUID.randomUUID().toString(), standardName.toLowerCase(), standardName.length()));
                }
                String zhStandardName = drugNameWord.getZhStandardName();
                if (StringUtils.isNotBlank(zhStandardName)) {
                    list5.add(new AssociationalWord(UUID.randomUUID().toString(), zhStandardName.toLowerCase(), zhStandardName.length()));
                }
            }
            elasticsearchRestTemplate.save(list5);
            System.out.println("[drug_name_words]写入完成");
        }
    }
}
