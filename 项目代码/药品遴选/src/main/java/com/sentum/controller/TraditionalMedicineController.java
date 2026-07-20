package com.sentum.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.DrugPriceDto;
import com.sentum.pojo.dto.TrChooseDto;
import com.sentum.pojo.vo.DataResult;
import com.sentum.service.TraditionalMedicineService;
import com.sentum.service.impl.LxGptServiceImpl;
import com.sentum.util.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.util.UUID;

@Slf4j
@Api(tags = "中药相关")
@RestController
@RequestMapping("/evaluation-api/traditional")
public class TraditionalMedicineController {
    
    @Autowired
    private TraditionalMedicineService traditionalMedicineService;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private LxGptServiceImpl lxGptService;



    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis-v2-app")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),
    })
    public DataResult guideOnAnalysisV2App(String drugName, String disease, String specifications, String id, String priceId, String drugId, String searchId, String isCustom, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(traditionalMedicineService.guideOnAnalysisV2App(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId));
    }

    @ApiOperation(value = "数据储存", notes = "data-save")
    @PostMapping("/data-save-v2-app")
    public DataResult dataSaveV2App(@RequestBody TrChooseDto jsonObject) {
//        String string = jsonObject.getPriceId();
//        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("priceId").is(string)), JSONObject.class, "drug_info_tra_v2_app");
//        if (jsonObjects != null){
//            mongoTemplate.remove(new Query(Criteria.where("priceId").is(string)), "drug_info_tra_v2_app");
//        }
        UUID uuid = UUID.randomUUID();
        jsonObject.getTrChooseList().forEach(trChoosexDto -> {
            trChoosexDto.setPriceId(uuid.toString());
            mongoTemplate.save(trChoosexDto, "drug_info_tra_v2_app");
        });
        log.info(jsonObject.toString());
        return DataResult.ok(uuid.toString());
    }
    
    
    
    
    
    
    
    
    
    


//    @RequestMapping()
    @ApiOperation(value = "获取说明书信息", notes = "drug-data-tal")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-data-tal")
    public DataResult drugDataTal(String disease, String searchId, String drugIds) {
        return DataResult.data(traditionalMedicineService.getDataTalPuls(disease, searchId, drugIds));
    }


      @ApiOperation(value = "数据储存", notes = "data-save")
    @PostMapping("/data-save")
    public DataResult dataSave(@RequestBody JSONObject jsonObject) {
        mongoTemplate.save(jsonObject, "drug_info_tra");
        log.info(jsonObject.toString());
        return DataResult.ok();
    }
    @ApiOperation(value = "保存用户输入的药品价格数据", notes = "save-drug-price")
    @PostMapping("/save-drug-price")
    public DataResult saveDrugPrice(@RequestBody DrugPriceDto saveDrugPriceDto) {
        String saveDrugPrice = traditionalMedicineService.saveDrugPrice(saveDrugPriceDto);
        if ("-1".equals(saveDrugPrice)) {
            return DataResult.error("价格表存储失败");
        }
        return DataResult.data(saveDrugPrice);
    }

    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),
            @ApiImplicitParam(name = "searchId", value = "检索流程id", required = true),

    })
    public DataResult guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId, String drugId, String searchId, String isCustom, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(traditionalMedicineService.guideOnAnalysis(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId));
    }

    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis-app")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),

    })
    public DataResult guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId, String drugId, String searchId, String isCustom, HttpServletRequest request, HttpServletResponse response, String priceLevel) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(traditionalMedicineService.guideOnAnalysisApp(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId));
    }


    @ApiOperation(value = "指南线上看板数据", notes = "guide-online-app")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-online-app")
    public DataResult guideOnlineApp(String id) {
        return DataResult.data(traditionalMedicineService.guideOnline(id));
    }

    @ApiOperation(value = "指南线上看板数据", notes = "guide-online")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-online")
    public DataResult guideOnline(String id) {
        return DataResult.data(traditionalMedicineService.guideOnline(id));
    }




    @ApiOperation(value = "指南线上看板数据", notes = "guide-online")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide")
    public DataResult guide() {
        return DataResult.data(lxGptService.searchGuideTop5("二甲双胍","高血糖"));
    }










    @ApiOperation(value = "获取说明书信息", notes = "drug-data-tal")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-data-tal-v2")
    public DataResult drugDataTalV2(String searchId, String drugIds) {
        return DataResult.data(traditionalMedicineService.getDataTalPulsV2( searchId, drugIds));
    }


    @ApiOperation(value = "数据储存", notes = "data-save")
    @PostMapping("/data-save-v2")
    public DataResult dataSaveV2(@RequestBody JSONObject jsonObject) {
        String string = jsonObject.getString("priceId");
        JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("priceId").is(string)), JSONObject.class, "drug_info_tra_v2");
        if (jsonObjects != null){
            mongoTemplate.remove(new Query(Criteria.where("priceId").is(string)), "drug_info_tra_v2");
        }
        mongoTemplate.save(jsonObject, "drug_info_tra_v2");
        log.info(jsonObject.toString());
        return DataResult.ok();
    }


   


    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis-v2")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),
            @ApiImplicitParam(name = "searchId", value = "检索流程id", required = true),

    })
    public DataResult guideOnAnalysisV2(String drugName, String disease, String specifications, String id, String priceId, String drugId, String searchId, String isCustom, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(traditionalMedicineService.guideOnAnalysisV2(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId));
    }

    

    @ApiOperation(value = "数据取", notes = "data-get-v2")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "流程id", required = true),
            @ApiImplicitParam(name = "priceId", value = "单词提交id", required = true),
        //    @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)

    })
    @GetMapping("/data-get-v2")
    public DataResult dataGetV2(  String id,String priceId, String drugIds) {
        if (StringUtils.isNotEmpty(priceId)){
            JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(priceId)), JSONObject.class, "tr_info_score_v2");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("data",jsonObjects);
            return DataResult.ok(jsonObject);
        }else {
            JSONObject jsonObjects = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "tr_info_score_v2");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("data",jsonObjects);
            return DataResult.ok(jsonObject);
        }

    }
}
