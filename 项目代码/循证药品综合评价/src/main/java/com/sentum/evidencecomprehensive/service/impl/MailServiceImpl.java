package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.mongo.MailInfo;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.vo.MailVo;
import com.sentum.evidencecomprehensive.service.MailService;
import com.sentum.evidencecomprehensive.utils.FormatUtil;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.BulkOperations;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

@Service
public class MailServiceImpl implements MailService {
    @Autowired
    private MongoTemplate mongoTemplate;

    @Override
    public String create(String id, Long userId) {
        String info = "";
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition != null) {
            boolean exists = mongoTemplate.exists(new Query(Criteria.where("_id").is(id)), MailInfo.class);
            if (!exists) {
                MailInfo mailInfo = new MailInfo();
                mailInfo.setId(id);
                mailInfo.setUserId(userId);
                info = info(condition);
                mailInfo.setInfo(info);
                mailInfo.setStatus(0);
                mailInfo.setCreateTime(System.currentTimeMillis());
                mongoTemplate.save(mailInfo);
            }
        }
        return info;
    }

    @Override
    public JSONObject list(Long userId, Integer pageSize, Integer pageNum) {
        JSONObject result = new JSONObject();
        //判断是否有未读数据
        Query queryExists = new Query();
        queryExists.addCriteria(Criteria.where("userId").is(userId).and("status").is(0));
        long count = mongoTemplate.count(queryExists, MailInfo.class);
        result.put("num", count);
        if (count > 0) {
            result.put("exists", true);
        } else {
            result.put("exists", false);
        }
        Query query = new Query(Criteria.where("userId").is(userId));
        query.with(PageRequest.of(pageNum - 1, pageSize, Sort.Direction.DESC, "createTime"));
        List<MailInfo> mailInfos = mongoTemplate.find(query, MailInfo.class);
        List<MailVo> list = new ArrayList<>();
        mailInfos.forEach(mailInfo -> list.add(FormatUtil.formMail(mailInfo)));
        result.put("list", list);
        return result;
    }

    @Override
    public Boolean read(String id, Boolean allRead, long userId) {
        if (Objects.nonNull(allRead) && allRead) {
            Query queryExists = new Query();
            queryExists.addCriteria(Criteria.where("userId").is(userId));
//            queryExists.addCriteria(Criteria.where("userId").is(userId).and("status").is(0));
            List<MailInfo> mailInfos = mongoTemplate.find(queryExists, MailInfo.class);
            List<String> notReadIds = mailInfos.stream().map(MailInfo::getId).collect(Collectors.toList());
            // 创建批量操作对象
            BulkOperations bulkOps = mongoTemplate.bulkOps(BulkOperations.BulkMode.UNORDERED, MailInfo.class, "evidence_mail_info");
            // 定义更新操作
            Update update = new Update();
            update.set("readTime", System.currentTimeMillis());
            update.set("status", 1);
            Query query = new Query(Criteria.where("_id").in(notReadIds));
            bulkOps.updateMulti(query, update);
            bulkOps.execute();
            return true;
        } else {
            Update update = new Update();
            update.set("readTime", System.currentTimeMillis());
            update.set("status", 1);
            UpdateResult updateResult = mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, MailInfo.class);
            return updateResult.getMatchedCount() > 0;
        }
    }



    private String info(Condition condition){
        StringBuilder info = new StringBuilder();
        //info.append("标题为<b>【");
        List<Drug> drugs = condition.getDrugs();
        if (CollUtil.isNotEmpty(drugs)){
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1){
                    info.append(drug.getWord());
                } else if (status == 2){
                    //与
                    info.append("联合");
                }else {
                    //非
                    info.append("排除");
                }
            }
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            info.append("治疗");
            for (Disease disease : diseases) {
                Integer status = disease.getStatus();
                if (status == 1){
                    info.append(disease.getWord());
                }else if (status == 2){
                    //与
                    info.append("合并");
                }else {
                    //非
                    info.append("排除");
                }
            }
        }
        //info.append("】</b>的课题已生成，可在<b>【课题列表】</b>中查看。");
        return info.toString();
    }
}
