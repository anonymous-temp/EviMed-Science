package com.sentum.controller;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.SaveAnalysisResult;
import com.sentum.pojo.StreamParams;
import com.sentum.pojo.VaeDownJsonSimple;
import com.sentum.pojo.vo.DataResult;
import com.sentum.service.VaeService;
import com.sentum.service.impl.VaeServiceImpl;
import com.sentum.util.RedisUtil;
import io.swagger.annotations.Api;
import lombok.extern.slf4j.Slf4j;
import lombok.var;
import org.apache.commons.collections4.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mapping.MappingException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Slf4j
@Api(tags = "自定义量表")
@RestController
@RequestMapping("/evaluation-api/vae")
public class Vae {

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private VaeService vaeService;



    @GetMapping("/export/excel")
    public void exportExcel(HttpServletResponse response,@RequestParam String reportId) {
        try {
            // 获取数据
            var evaluation = vaeService.getDrugEvaluationData(reportId);
            // 导出Excel
            vaeService.exportToExcel(evaluation, response);
        } catch (IllegalArgumentException e) {
            log.error("发生错误{}",e);
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
        } catch (IOException e) {
            log.error("发生错误{}",e);
            response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        } catch (Exception e) {
            log.error("发生错误{}",e);
            response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        }
    }






    @PostMapping("/get-analysis")
    public void getAnalysis(@RequestBody StreamParams streamParams, HttpServletRequest request, HttpServletResponse response) {
        String[] split1 = streamParams.getDrugId().split(",");



        if (StringUtils.isNotEmpty(streamParams.getDisease())){
            String[] split11 = streamParams.getDisease().split(";");
            for (String s : split1) {
                    for (String s1 : split11) {
                        vaeService.guidePanel( s, s1,streamParams.getScaleId(), response, streamParams.getScaleId());
                    }
                }
            }else {
            for (String s : split1) {
                vaeService.guidePanel( s, "",streamParams.getScaleId(), response, streamParams.getScaleId());
            }
        }

        }



        @GetMapping("/download")
        public void down(HttpServletRequest request, HttpServletResponse response,String reportId) {
        vaeService.download(reportId, response);
        }


        @GetMapping("/get-table")
        public DataResult getTable(String scaleId) {

            Object panelFor = vaeService.getPanelFor(scaleId);
            return DataResult.data(panelFor);
        }











    //保存接口
    @PostMapping("/save")
    public DataResult save(@RequestBody List<JSONObject> jsonObject){
        String stringList = UUID.randomUUID().toString();
        ArrayList<String> strings = new ArrayList<>();
        ArrayList<VaeDownJsonSimple> vaeDownJsonSimples = new ArrayList<>();
        for (JSONObject jsonObject1 : jsonObject) {
            String string = UUID.randomUUID().toString();
            JSONObject object = new JSONObject();
            String scaleId = jsonObject1.getString("scaleId");
            JSONObject byScaleId = mongoTemplate.findOne(Query.query(Criteria.where("_id").is(scaleId)), JSONObject.class, "evaluation_vae");
            String scaleName = byScaleId.getString("scaleName");
            jsonObject1.put("scaleName", scaleName);
            object.put("id", string);
            object.put("listId", stringList);
            object.put("info", jsonObject1);
            VaeDownJsonSimple vaeDownJsonSimple = JSONObject.parseObject(JSONObject.toJSONString(jsonObject1), VaeDownJsonSimple.class);
            vaeDownJsonSimple.setId( string);
            vaeDownJsonSimples.add(vaeDownJsonSimple);
            vaeService.save(object);
            strings.add(string);
        }
        JSONObject object = new JSONObject();
        object.put("listId", stringList);
        object.put("listInfo",vaeDownJsonSimples);
        mongoTemplate.save(object, "evaluation_vae_score_list");
        return DataResult.data(strings);
    }


    //查询接口
    @GetMapping("/get-report")
    public DataResult getReport(HttpServletRequest request, HttpServletResponse response, String reportId){
        JSONObject report = vaeService.getReport(reportId);
        if (report == null){
            return DataResult.error("未找到该报告");
        }
        JSONObject jsonObject = report.getJSONObject("info");
        String listId = report.getString("listId");
        JSONObject vaeDownJsonSimple = mongoTemplate.findOne(new Query(Criteria.where("listId").is(listId)),JSONObject.class,"evaluation_vae_score_list");
        Object o = vaeDownJsonSimple.get("listInfo");
        jsonObject.put("listInfo",o);
        return DataResult.data(jsonObject);

    }























    @PostMapping("/saveVaeTable")
    public DataResult saveVaeTable(@RequestBody com.sentum.pojo.Vae vae, HttpServletRequest request, HttpServletResponse response){
        String userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.get("userId").toString();
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        vae.setCreator(userId);
        String id = vae.getId();
        if (StringUtils.isNotEmpty(vae.getId())){
            try {
                mongoTemplate.remove(new Query(Criteria.where("id").is(vae.getId())));
            }catch (MappingException e) {
                log.info("未知id");
            }
            id = vae.getId();
        }else {
            id = UUID.randomUUID().toString();
            vae.setId(id);
        }


        mongoTemplate.save(vae);

        return DataResult.ok();
    }


    @GetMapping("/getVaeTable")
    public DataResult getVaeTable(HttpServletRequest request, HttpServletResponse response) {
        final int REQUIRED_TABLE_COUNT = 3;

        // Step 1: 解析用户 ID
        String userId = getUserIdFromToken(request);
        if (userId == null) {
            response.setStatus(401);
            log.warn("未授权访问：token缺失或无效");
            return DataResult.error(401, "Authentication failed: token can't be null or invalid");
        }

        // Step 2: 查询用户现有的 VAE 表格（使用全限定类名）
        Query query = new Query(Criteria.where("creator").is(userId));
        List<com.sentum.pojo.Vae> userTables = mongoTemplate.find(query, com.sentum.pojo.Vae.class);

        List<com.sentum.pojo.Vae> resultTables = new ArrayList<>();

        if (userTables.isEmpty()) {
            log.info("用户 {} 无历史表格，正在初始化...", userId);
            for (int i = 0; i <= REQUIRED_TABLE_COUNT; i++) {
                com.sentum.pojo.Vae vae = createDefaultVae(userId);
                mongoTemplate.save(vae);
                resultTables.add(vae);
            }
        } else {
            // 取前3个
            int size = Math.min(userTables.size(), REQUIRED_TABLE_COUNT);
            resultTables.addAll(userTables.subList(0, size));

            // 补充默认值
            normalizeVaeData(resultTables);
        }

        // 返回结果
        JSONArray jsonArray = new JSONArray();
        jsonArray.addAll(resultTables);
        return DataResult.data(jsonArray);
    }

    // 使用全限定类名定义方法签名
    private com.sentum.pojo.Vae createDefaultVae(String userId) {
        com.sentum.pojo.Vae vae = new com.sentum.pojo.Vae();
        vae.setId(UUID.randomUUID().toString());
        vae.setCreator(userId);
        vae.setLimitDisease(true);
        vae.setDimensions(new ArrayList<>());
        return vae;
    }

    private void normalizeVaeData(List<com.sentum.pojo.Vae> tables) {
        for (com.sentum.pojo.Vae vae : tables) {
            if (vae.getLimitDisease() == null) {
                vae.setLimitDisease(true);
            }

            if (CollectionUtils.isEmpty(vae.getDimensions())) {
                vae.setDimensions(new ArrayList<>());
                continue;
            }

            for (com.sentum.pojo.Vae.Dimension dimension : vae.getDimensions()) {
                if (CollectionUtils.isEmpty(dimension.getItems())) {
                    continue;
                }

                for (com.sentum.pojo.Vae.Item item : dimension.getItems()) {
                    if (item.getResultType() == null) item.setResultType("");
                    if (item.getEvaluationType() == null) item.setEvaluationType("");
                    if (item.getImportData() == null) item.setImportData(new ArrayList<>());
                }
            }
        }
    }



    private String getUserIdFromToken(HttpServletRequest request) {
        try {
            String token = request.getHeader("token");
            if (StringUtils.isEmpty(token)) {
                return null;
            }

            String redisKey = "access_token_" + token;
            Object redisObj = RedisUtil.redis.opsForValue().get(redisKey);
            if (redisObj == null) {
                log.warn("Redis 中未找到 token 对应的会话: {}", redisKey);
                return null;
            }

            JSONObject redisMap = JSON.parseObject(redisObj.toString());
            String userId = redisMap.getString("userId");
            if (StringUtils.isEmpty(userId)) {
                log.warn("Redis 中 token 数据缺少 userId: {}", redisKey);
                return null;
            }

            return userId;
        } catch (Exception e) {
            log.error("解析用户身份失败", e);
            return null;
        }
    }





}
